import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetSession = vi.fn();
vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: () => mockGetSession(),
  getAdminUserHelper: () => mockGetSession(),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
  clientIpFromRequest: vi.fn().mockReturnValue('127.0.0.1'),
}));

const mockResolveActiveUserModel = vi.fn();
const mockToInjectableStructuredModel = vi.fn();
vi.mock('@/lib/ai/user-model-resolver', () => ({
  resolveActiveUserModel: (userId?: string | null) => mockResolveActiveUserModel(userId),
  // route 已改走 key-status helper（批次 B）：mock 派生同语义，保留旧断言（MISSING → 400）
  resolveUserModelWithKeyStatus: async (userId?: string | null) => {
    const model = await mockResolveActiveUserModel(userId);
    return model ? { ok: true as const, model } : { ok: false as const, code: 'MISSING_API_KEY' as const };
  },
  toInjectableStructuredModel: (model: any) => mockToInjectableStructuredModel(model),
}));

const mockGenerateStructured = vi.fn();
const mockTrackTokenUsage = vi.fn();
vi.mock('@/lib/ai', () => ({
  generateStructured: (...args: any[]) => mockGenerateStructured(...args),
  trackTokenUsage: (...args: any[]) => mockTrackTokenUsage(...args),
  getModel: vi.fn().mockReturnValue({ modelId: 'mock-model' }),
}));

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/ai/diagram-lens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/ai/diagram-lens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: 'user-42', email: 'test@opengits.org' } });
    mockResolveActiveUserModel.mockResolvedValue({
      provider: 'dashscope',
      modelId: 'qwen-max',
      apiKey: 'sk-mock-key',
      baseURL: 'https://api.mock.com',
      apiFormat: 'openai',
    });
    mockToInjectableStructuredModel.mockReturnValue({ modelId: 'mock-model' });
  });

  it('未登录时返回 401 失败信封', async () => {
    mockGetSession.mockResolvedValue(null);
    const { POST } = await import('@/app/api/ai/diagram-lens/route');
    const res = await POST(makeRequest({ chart: 'graph TD\n  A --> B', targetDepth: 'standard' }), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe('UNAUTHORIZED');
  });

  it('缺少 chart 时返回 400 校验错误', async () => {
    const { POST } = await import('@/app/api/ai/diagram-lens/route');
    const res = await POST(makeRequest({ targetDepth: 'standard' }), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('targetDepth 不合法时返回 400 校验错误', async () => {
    const { POST } = await import('@/app/api/ai/diagram-lens/route');
    const res = await POST(makeRequest({ chart: 'graph TD\n  A --> B', targetDepth: 'ultra-deep' }), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('未配置或未激活自备模型时返回 400 MISSING_API_KEY', async () => {
    mockResolveActiveUserModel.mockResolvedValue(null);
    const { POST } = await import('@/app/api/ai/diagram-lens/route');
    const res = await POST(makeRequest({ chart: 'graph TD\n  A --> B', targetDepth: 'standard' }), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe('MISSING_API_KEY');
  });

  it('生成 standard 深度图表时返回 200 及标准化流程图', async () => {
    mockGenerateStructured.mockResolvedValue({
      object: {
        mermaidCode: `flowchart LR
  client["Client: Web"] -->|"Request: JSON"| gateway["API: Gateway"]
  gateway --> auth["Auth: Service"]`,
      },
      usage: { promptTokens: 100, completionTokens: 50 },
    });

    const { POST } = await import('@/app/api/ai/diagram-lens/route');
    const res = await POST(
      makeRequest({
        chart: 'graph TD\n  A --> B',
        targetDepth: 'standard',
        title: 'Auth Pipeline',
      }),
      { params: Promise.resolve({}) }
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.ok).toBe(true);
    expect(json.data.mermaidCode).toContain('flowchart LR');
    expect(json.data.mermaidCode).toContain('client["Client: Web"]');
    expect(mockTrackTokenUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: 'diagram_lens', userId: 'user-42' })
    );
  });

  it('生成 deep 深度图表且输出包含未加引号的特殊标签时，自动双引号包裹自愈', async () => {
    mockGenerateStructured.mockResolvedValue({
      object: {
        mermaidCode: `flowchart TB
subgraph Ingest [Ingest Engine: Parser (v1)]
  worker[Worker: Background Job] --> db[(Postgres: Primary (5432))]
end`,
      },
      usage: { promptTokens: 150, completionTokens: 80 },
    });

    const { POST } = await import('@/app/api/ai/diagram-lens/route');
    const res = await POST(
      makeRequest({
        chart: 'graph TD\n  A --> B',
        targetDepth: 'deep',
        userPrompt: 'focus on postgres storage',
      }),
      { params: Promise.resolve({}) }
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.ok).toBe(true);
    // 验证特殊字符节点自动被双引号包裹
    expect(json.data.mermaidCode).toContain('subgraph Ingest ["Ingest Engine: Parser (v1)"]');
    expect(json.data.mermaidCode).toContain('worker["Worker: Background Job"]');
    expect(json.data.mermaidCode).toContain('db[("Postgres: Primary (5432)")]');
  });

  it('当 LLM 生成抛出异常时捕获并返回标准 500 错误', async () => {
    mockGenerateStructured.mockRejectedValue(new Error('LLM Gateway Connection Timeout'));

    const { POST } = await import('@/app/api/ai/diagram-lens/route');
    const res = await POST(
      makeRequest({
        chart: 'graph TD\n  A --> B',
        targetDepth: 'standard',
      }),
      { params: Promise.resolve({}) }
    );

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.success).toBe(false);
  });
});
