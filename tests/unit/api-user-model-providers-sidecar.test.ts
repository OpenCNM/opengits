import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SidecarError } from '@/lib/sidecar-client';
import { encryptApiKey } from '@/lib/crypto/api-key-cipher';

const callSidecarMock = vi.fn();
vi.mock('@/lib/sidecar-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sidecar-client')>('@/lib/sidecar-client');
  return {
    ...actual,
    callSidecar: (...args: unknown[]) => callSidecarMock(...args),
  };
});

const getSessionHelperMock = vi.fn();
vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: (...args: unknown[]) => getSessionHelperMock(...args),
  getAdminUserHelper: (...args: unknown[]) => getSessionHelperMock(...args),
}));

describe('GET /api/user/model-providers (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function callGet() {
    const { GET } = await import('@/app/api/user/model-providers/route');
    const req = new NextRequest('http://localhost/api/user/model-providers', { method: 'GET' });
    return GET(req);
  }

  it('未登录时返回 401', async () => {
    getSessionHelperMock.mockResolvedValue(null);
    const res = await callGet();
    expect(res.status).toBe(401);
  });

  it('正常返回脱敏 providers 列表', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });

    const mockProviders = [
      {
        id: 'p-1',
        providerKey: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        maskedApiKey: 'sk-te••••••••••••1234',
        hasApiKey: true,
        apiFormat: 'openai',
        models: ['gpt-4o'],
        selectedModel: 'gpt-4o',
        isActive: true,
        healthStatus: 'unknown',
        latencyMs: null,
        lastError: null,
        lastTestedAt: null,
        createdAt: '2026-09-22T00:00:00Z',
        updatedAt: '2026-09-22T00:00:00Z',
      },
    ];

    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      providers: mockProviders,
    });

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      data: { providers: mockProviders },
    });
  });
});

describe('POST /api/user/model-providers (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function callPost(payload: unknown) {
    const { POST } = await import('@/app/api/user/model-providers/route');
    const req = new NextRequest('http://localhost/api/user/model-providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return POST(req);
  }

  it('未登录时返回 401', async () => {
    getSessionHelperMock.mockResolvedValue(null);
    const res = await callPost({
      providerKey: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      models: ['gpt-4o'],
      selectedModel: 'gpt-4o',
    });
    expect(res.status).toBe(401);
  });

  it('有效参数成功 upsert 模型提供商', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });

    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      provider: {
        id: 'p-1',
        providerKey: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        maskedApiKey: 'sk-te••••••••••••1234',
        hasApiKey: true,
        apiFormat: 'openai',
        models: ['gpt-4o'],
        selectedModel: 'gpt-4o',
        isActive: true,
        healthStatus: 'unknown',
        latencyMs: null,
        lastError: null,
        lastTestedAt: null,
        createdAt: '2026-09-22T00:00:00Z',
        updatedAt: '2026-09-22T00:00:00Z',
      },
    });

    const res = await callPost({
      providerKey: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-12345678',
      models: ['gpt-4o'],
      selectedModel: 'gpt-4o',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.provider.providerKey).toBe('openai');
  });

  it('sidecar 返回 API_KEY_REQUIRED 时正确返回 400', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });

    callSidecarMock.mockRejectedValueOnce(
      new SidecarError('failed: 新增配置必须填写 API Key (API_KEY_REQUIRED)', 400)
    );

    const res = await callPost({
      providerKey: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      models: ['gpt-4o'],
      selectedModel: 'gpt-4o',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('API_KEY_REQUIRED');
  });
});

describe('PATCH /api/user/model-providers (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function callPatch(payload: unknown) {
    const { PATCH } = await import('@/app/api/user/model-providers/route');
    const req = new NextRequest('http://localhost/api/user/model-providers', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return PATCH(req);
  }

  it('提供商不存在时返回 404 PROVIDER_NOT_FOUND', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });

    callSidecarMock.mockRejectedValueOnce(
      new SidecarError('Provider not found', 404)
    );

    const res = await callPatch({
      providerKey: 'unknown',
      makeActive: true,
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('PROVIDER_NOT_FOUND');
  });

  it('成功更新主模型与激活状态', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });

    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      provider: {
        id: 'p-1',
        providerKey: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        maskedApiKey: 'sk-te••••••••••••1234',
        hasApiKey: true,
        apiFormat: 'openai',
        models: ['gpt-4o', 'gpt-4o-mini'],
        selectedModel: 'gpt-4o-mini',
        isActive: true,
        healthStatus: 'unknown',
        latencyMs: null,
        lastError: null,
        lastTestedAt: null,
        createdAt: '2026-09-22T00:00:00Z',
        updatedAt: '2026-09-22T00:00:00Z',
      },
    });

    const res = await callPatch({
      providerKey: 'openai',
      selectedModel: 'gpt-4o-mini',
      makeActive: true,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.provider.selectedModel).toBe('gpt-4o-mini');
  });
});

describe('DELETE /api/user/model-providers (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function callDelete(query: string) {
    const { DELETE } = await import('@/app/api/user/model-providers/route');
    const req = new NextRequest(`http://localhost/api/user/model-providers${query}`, {
      method: 'DELETE',
    });
    return DELETE(req);
  }

  it('缺少 providerKey 返回 400', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });

    const res = await callDelete('');
    expect(res.status).toBe(400);
  });

  it('正常删除返回 200', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });

    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      deleted: true,
    });

    const res = await callDelete('?providerKey=openai');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      data: { deleted: true },
    });
  });
});

describe('POST /api/ai/test-provider (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function callTestProvider(payload: unknown) {
    const { POST } = await import('@/app/api/ai/test-provider/route');
    const req = new NextRequest('http://localhost/api/ai/test-provider', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return POST(req);
  }

  it('未登录时返回 401', async () => {
    getSessionHelperMock.mockResolvedValue(null);
    const res = await callTestProvider({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    });
    expect(res.status).toBe(401);
  });

  it('缺少 apiKey 与 cloud config 时返回 400 MISSING_API_KEY', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });

    const res = await callTestProvider({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('MISSING_API_KEY');
  });

  it('按 providerKey 自取云端密文并解密成功', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });

    const plainKey = 'sk-provider-key-test';
    const cipher = encryptApiKey(plainKey);

    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      apiKey: cipher,
    });

    // Mock Anthropic fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ text: 'OK' }] }), { status: 200 })
    );

    const res = await callTestProvider({
      baseUrl: 'https://api.anthropic.com',
      providerKey: 'anthropic',
      apiFormat: 'anthropic',
      model: 'claude-3-5-sonnet',
    });

    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/user/model-providers/get-cipher',
      { userId: 'usr-123', providerKey: 'anthropic' },
      expect.objectContaining({ label: 'ai/test-provider /v1/user/model-providers/get-cipher' })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    fetchSpy.mockRestore();
  });
});
