import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  getSessionHelperMock,
  resolveActiveUserModelMock,
  tutorAgentRunMock,
  repoFindFirstMock,
  userFindUniqueMock,
  callSidecarMock,
} = vi.hoisted(() => ({
  getSessionHelperMock: vi.fn(),
  resolveActiveUserModelMock: vi.fn(),
  tutorAgentRunMock: vi.fn(),
  repoFindFirstMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  callSidecarMock: vi.fn(),
}));

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: (...args: unknown[]) => getSessionHelperMock(...args),
  getAdminUserHelper: (...args: unknown[]) => getSessionHelperMock(...args),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
  clientIpFromRequest: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/observability/errors', () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/ai/user-model-resolver', () => ({
  resolveActiveUserModel: (...args: unknown[]) => resolveActiveUserModelMock(...args),
  // route 已改走 key-status helper（批次 B）：mock 派生同语义，保留旧断言（BYOK fail-closed 409）
  resolveUserModelWithKeyStatus: async (...args: unknown[]) => {
    const model = await resolveActiveUserModelMock(...args);
    return model ? { ok: true as const, model } : { ok: false as const, code: 'MISSING_API_KEY' as const };
  },
}));

vi.mock('@/lib/agent/langfuse', () => ({
  langfuse: {
    trace: vi.fn().mockReturnValue({
      id: 'trace-xyz-123',
      generation: vi.fn(),
    }),
    flushAsync: vi.fn(),
  },
  getCachedTutorPrompt: vi.fn().mockReturnValue('Mocked system prompt'),
}));

vi.mock('@/lib/agent/tutor-agent', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    TutorAgent: {
      run: (...args: unknown[]) => tutorAgentRunMock(...args),
    },
  };
});

vi.mock('@/lib/memory/working-memory', () => ({
  WorkingMemoryManager: {
    saveMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
  },
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: (...args: unknown[]) => userFindUniqueMock(...args) },
    repository: { findFirst: (...args: unknown[]) => repoFindFirstMock(...args) },
    conversation: { create: vi.fn().mockResolvedValue({ id: 'conv-123' }) },
    episodicEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    conversationMessage: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

describe('POST /api/chat route hardening & observability', () => {
  function jsonNextRequest(url: string, body?: unknown, headers: Record<string, string> = {}): NextRequest {
    return new NextRequest(`http://localhost${url}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getSessionHelperMock.mockResolvedValue({ user: { id: 'user-test-1' } });
    resolveActiveUserModelMock.mockResolvedValue({
      apiKey: 'sk-test-key',
      modelId: 'gpt-4o',
      provider: 'openai',
    });
    userFindUniqueMock.mockResolvedValue({ preferredLang1: 'zh-CN', primaryProgLang: 'TypeScript' });
    repoFindFirstMock.mockResolvedValue({ id: 'repo-abc', owner: 'test-org', repo: 'test-project' });
    callSidecarMock.mockResolvedValue({ ok: true, conversation: { id: 'conv-123' } });
  });

  it('BYOK fail-closed: rejects request when user has no active API key', async () => {
    resolveActiveUserModelMock.mockResolvedValue(null);

    const { POST } = await import('@/app/api/chat/route');
    const req = jsonNextRequest('/api/chat', {
      owner: 'test-org',
      repo: 'test-project',
      messages: [{ role: 'user', content: 'hello' }],
    });

    const res = await POST(req, { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('MISSING_API_KEY');
  });

  it('rejects request when owner or repo is missing', async () => {
    const { POST } = await import('@/app/api/chat/route');
    const req = jsonNextRequest('/api/chat', {
      messages: [{ role: 'user', content: 'hello' }],
    });

    const res = await POST(req, { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('INVALID_PARAM');
  });

  it('propagates x-llm-call-id header and enables sendReasoning in toUIMessageStreamResponse', async () => {
    let capturedStreamOptions: any = null;
    const mockToUIMessageStreamResponse = vi.fn().mockImplementation((opts: any) => {
      capturedStreamOptions = opts;
      return new Response('stream content', {
        status: 200,
        headers: {
          ...opts?.headers,
          'content-type': 'text/plain; charset=utf-8',
        },
      });
    });

    tutorAgentRunMock.mockResolvedValue({
      result: {
        toUIMessageStreamResponse: mockToUIMessageStreamResponse,
      },
      traceId: 'trace-xyz-123',
    });

    const { POST } = await import('@/app/api/chat/route');
    const customCallId = 'test-call-id-999';
    const req = jsonNextRequest(
      '/api/chat',
      {
        owner: 'test-org',
        repo: 'test-project',
        messages: [{ role: 'user', content: 'explain concepts' }],
      },
      {
        'x-llm-call-id': customCallId,
      }
    );

    const res = await POST(req, { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(200);

    // TutorAgent.run should have received callId
    expect(tutorAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: customCallId,
      })
    );

    // toUIMessageStreamResponse should receive sendReasoning: true and headers
    expect(capturedStreamOptions.sendReasoning).toBe(true);
    expect(capturedStreamOptions.headers['x-llm-call-id']).toBe(customCallId);
    expect(capturedStreamOptions.headers['x-langfuse-trace-id']).toBe('trace-xyz-123');

    // Outgoing NextResponse must propagate x-llm-call-id
    expect(res.headers.get('x-llm-call-id')).toBe(customCallId);
  });

  it('sliding window: oversized latest message is safely truncated with fence auto-repair', async () => {
    tutorAgentRunMock.mockResolvedValue({
      result: {
        toUIMessageStreamResponse: vi.fn().mockReturnValue(new Response('ok')),
      },
      traceId: 'trace-trunc-1',
    });

    const hugeUnclosedCodeMessage = [
      '请分析这段代码：',
      '```typescript',
      'export function hugeFunction() {',
      ...Array(3000).fill('  const a = computeSomethingVeryLong();'),
      // 未闭合代码块
    ].join('\n');

    const { POST } = await import('@/app/api/chat/route');
    const req = jsonNextRequest('/api/chat', {
      owner: 'test-org',
      repo: 'test-project',
      messages: [{ role: 'user', content: hugeUnclosedCodeMessage }],
    });

    const res = await POST(req, { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(200);

    expect(tutorAgentRunMock).toHaveBeenCalledTimes(1);
    const passedMessages = tutorAgentRunMock.mock.calls[0][0].messages;
    expect(passedMessages).toHaveLength(1);
    const truncatedContent = passedMessages[0].content;

    // 验证代码块被自动闭合（fences 成对）
    const fences = truncatedContent.match(/^[ \t]{0,3}(`{3,}|~{3,})/gm) || [];
    expect(fences.length % 2).toBe(0);
    expect(truncatedContent).toContain('... [Message content truncated to fit cognitive budget]');
  });
});
