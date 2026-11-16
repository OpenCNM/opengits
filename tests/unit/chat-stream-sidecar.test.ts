import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCallSidecarStream = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecarStream: (...args: unknown[]) => mockCallSidecarStream(...args),
}));

const mockSaveMessage = vi.fn().mockResolvedValue({ id: 'msg-saved-1' });
vi.mock('@/lib/memory/working-memory', () => ({
  WorkingMemoryManager: {
    saveMessage: (...args: unknown[]) => mockSaveMessage(...args),
  },
}));

const mockLogUsage = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/analytics/token-usage', () => ({
  TokenUsageService: {
    logUsage: (...args: unknown[]) => mockLogUsage(...args),
  },
}));

vi.mock('@/lib/agent/langfuse', () => ({
  langfuse: {
    trace: vi.fn().mockReturnValue({
      id: 'trace-123',
      generation: vi.fn(),
    }),
    flushAsync: vi.fn(),
  },
  getCachedTutorPrompt: vi.fn().mockReturnValue('Mock system prompt'),
}));

vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({ text: 'FACTUAL_SEARCH' }),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: { findUnique: vi.fn().mockResolvedValue({ gitSha: 'sha-abc' }) },
    episodicEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    conversationMessage: { findMany: vi.fn().mockResolvedValue([]) },
    promptTemplate: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

describe('TutorAgent Go Sidecar Stream Offloading (W2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offloads stream to /v1/llm/stream with AI SDK data-stream format and wraps stream in response', async () => {
    // 模拟 Go Sidecar 返回的 AI SDK 流
    const mockChunks = [
      'b:"Thinking step 1"\n',
      '0:"Hello from Go sidecar"\n',
      'd:{"finishReason":"stop","usage":{"promptTokens":12,"completionTokens":24}}\n',
    ];
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      start(controller) {
        for (const chunk of mockChunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    mockCallSidecarStream.mockResolvedValue(
      new Response(readable, {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-vercel-ai-data-stream': 'v1',
        },
      })
    );

    const { TutorAgent } = await import('@/lib/agent/tutor-agent');
    const { result, traceId } = await TutorAgent.run({
      userId: 'u1',
      sessionId: 's1',
      owner: 'acme',
      repo: 'widget',
      messages: [{ role: 'user', content: 'hello' }],
      customApiKey: 'sk-byok-test',
      selectedModel: 'gpt-4o',
      provider: 'openai',
      callId: 'call-sidecar-1',
    } as any);

    expect(traceId).toBe('trace-123');
    expect(mockCallSidecarStream).toHaveBeenCalledWith(
      '/v1/llm/stream',
      expect.objectContaining({
        model: expect.objectContaining({
          provider: 'openai',
          modelId: 'gpt-4o',
          apiKey: 'sk-byok-test',
        }),
        streamFormat: 'ai-sdk',
        callId: 'call-sidecar-1',
      }),
      expect.objectContaining({ label: 'chat /v1/llm/stream' })
    );

    // 验证 toUIMessageStreamResponse 包装响应
    const streamRes = (result as any).toUIMessageStreamResponse({
      headers: {
        'x-custom-header': 'custom-val',
      },
    });

    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('x-vercel-ai-data-stream')).toBe('v1');
    expect(streamRes.headers.get('x-llm-call-id')).toBe('call-sidecar-1');
    expect(streamRes.headers.get('x-custom-header')).toBe('custom-val');

    // 消费流并验证内容完整
    const text = await streamRes.text();
    expect(text).toContain('b:"Thinking step 1"');
    expect(text).toContain('0:"Hello from Go sidecar"');
    expect(text).toContain('d:{"finishReason":"stop"');

    // 等待异步背景记账与记忆存储
    await new Promise((r) => setTimeout(r, 20));
    expect(mockSaveMessage).toHaveBeenCalledWith(
      'u1',
      's1',
      'assistant',
      'Hello from Go sidecar',
      undefined,
      expect.objectContaining({
        promptTokens: 12,
        completionTokens: 24,
      })
    );
    expect(mockLogUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        promptTokens: 12,
        completionTokens: 24,
      })
    );
  });

  it('fails closed when sidecar unreachable', async () => {
    mockCallSidecarStream.mockRejectedValue(new Error('sidecar down'));

    const { TutorAgent } = await import('@/lib/agent/tutor-agent');
    await expect(
      TutorAgent.run({
        userId: 'u1',
        sessionId: 's1',
        owner: 'acme',
        repo: 'widget',
        messages: [{ role: 'user', content: 'hello' }],
        customApiKey: 'sk-byok-test',
        selectedModel: 'gpt-4o',
        provider: 'openai',
      } as any)
    ).rejects.toThrow('sidecar down');
  });
});
