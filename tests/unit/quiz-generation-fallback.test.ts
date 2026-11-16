import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { generateStructuredMock, resolveActiveUserModelMock, checkRepositoryAccessMock } = vi.hoisted(() => ({
  generateStructuredMock: vi.fn(),
  resolveActiveUserModelMock: vi.fn(),
  checkRepositoryAccessMock: vi.fn(),
}));

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: vi.fn().mockResolvedValue({ user: { id: 'u1' } }),
}));

vi.mock('@/lib/auth-utils', () => ({
  checkRepositoryAccess: (...args: unknown[]) => checkRepositoryAccessMock(...args),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/ai', () => ({
  generateStructured: (...args: unknown[]) => generateStructuredMock(...args),
  trackTokenUsage: vi.fn(),
  modelName: 'gpt-4',
}));

vi.mock('@/lib/ai/user-model-resolver', () => ({
  resolveActiveUserModel: (...args: unknown[]) => resolveActiveUserModelMock(...args),
  toInjectableStructuredModel: vi.fn((m) => m ? { provider: 'openai', modelId: 'test-model' } : null),
}));

describe('Quiz Generation Fallback (Item 8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveActiveUserModelMock.mockResolvedValue({ apiKey: 'sk-test', modelId: 'gpt-4' });
  });

  // 🧪 [3.4.1.1 · MEDIUM] AI 生成格式不合规或未通过结构化校验时严格失效封闭 (Fail-Closed)
  it('3.4.1.1 fails closed with GENERATION_FAILED on unexpected AI generation error', async () => {
    generateStructuredMock.mockRejectedValue(new Error('LLM JSON parse error or rate limit'));

    const { POST } = await import('@/app/api/quiz/generate/route');
    const req = new NextRequest('http://localhost/api/quiz/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Document content here...' }),
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe('GENERATION_FAILED');
    expect(json.error).toContain('测验题目生成未能通过结构化校验');
  });

  it('fails closed with MISSING_API_KEY when active user model is not configured', async () => {
    resolveActiveUserModelMock.mockResolvedValue(null);

    const { POST } = await import('@/app/api/quiz/generate/route');
    const req = new NextRequest('http://localhost/api/quiz/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Document content here...' }),
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe('MISSING_API_KEY');
  });

  it('still returns 429 when BudgetExceededError is thrown', async () => {
    const budgetError = new Error('平台今日 AI 额度已用尽');
    budgetError.name = 'BudgetExceededError';
    generateStructuredMock.mockRejectedValue(budgetError);

    const { POST } = await import('@/app/api/quiz/generate/route');
    const req = new NextRequest('http://localhost/api/quiz/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Document content here...' }),
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(429);
  });

  it('throws 403 Forbidden when user does not have access to repository', async () => {
    checkRepositoryAccessMock.mockResolvedValue(false);

    const { POST } = await import('@/app/api/quiz/generate/route');
    const req = new NextRequest('http://localhost/api/quiz/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Document content...', repositoryId: 'repo-123' }),
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe('Forbidden');
    expect(checkRepositoryAccessMock).toHaveBeenCalledWith('repo-123', 'u1');
  });

  it('allows generation when user has repository access', async () => {
    checkRepositoryAccessMock.mockResolvedValue(true);
    generateStructuredMock.mockResolvedValue({
      object: {
        quizzes: [
          {
            question: 'What is X?',
            options: ['A', 'B', 'C', 'D'],
            correctIndex: 0,
            explanation: 'A is correct',
          },
        ],
      },
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    });

    const { POST } = await import('@/app/api/quiz/generate/route');
    const req = new NextRequest('http://localhost/api/quiz/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Document content...', repositoryId: 'repo-123' }),
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(checkRepositoryAccessMock).toHaveBeenCalledWith('repo-123', 'u1');
    expect(json.data.quizzes).toHaveLength(1);
  });

  it('supports adaptive quiz generation with mixed difficulties determined by LLM', async () => {
    checkRepositoryAccessMock.mockResolvedValue(true);
    generateStructuredMock.mockResolvedValue({
      object: {
        quizzes: [
          {
            question: 'What is the primary role of Gateway?',
            options: ['Reverse proxy', 'Relational database', 'Compiler', 'CSS parser'],
            correctIndex: 0,
            explanation: 'Gateway acts as the primary websocket and reverse proxy gateway.',
            difficulty: 'easy',
          },
          {
            question: 'How does the locking state machine recover from stale processing?',
            options: ['Atomically resets to UNPROCESSED after timeout', 'Drops the table', 'Broadcasts 404', 'Ignores the timeout'],
            correctIndex: 0,
            explanation: 'The heartbeat scheduler atomically reclaims stale processing documents.',
            difficulty: 'hard',
          },
        ],
      },
      usage: { promptTokens: 30, completionTokens: 40, totalTokens: 70 },
    });

    const { POST } = await import('@/app/api/quiz/generate/route');
    const req = new NextRequest('http://localhost/api/quiz/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Document on gateway architecture and lock recovery...' }),
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.quizzes).toHaveLength(2);
    expect(json.data.quizzes[0].difficulty).toBe('easy');
    expect(json.data.quizzes[1].difficulty).toBe('hard');
  });
});
