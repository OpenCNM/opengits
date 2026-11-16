import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const callSidecarMock = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

const getSessionHelperMock = vi.fn();
vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: (...args: unknown[]) => getSessionHelperMock(...args),
  getAdminUserHelper: (...args: unknown[]) => getSessionHelperMock(...args),
}));

describe('GET /api/mcp/tokens (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function callGetTokens() {
    const { GET } = await import('@/app/api/mcp/tokens/route');
    const req = new NextRequest('http://localhost/api/mcp/tokens', { method: 'GET' });
    return GET(req);
  }

  it('未登录时返回 401', async () => {
    getSessionHelperMock.mockResolvedValue(null);
    const res = await callGetTokens();
    expect(res.status).toBe(401);
  });

  it('正常拉取脱敏 token 列表', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });

    const mockTokens = [
      {
        id: 'tok-1',
        name: 'Cursor IDE',
        prefix: 'mcp_1234',
        lastUsedAt: '2026-09-21T00:00:00Z',
        createdAt: '2026-09-20T00:00:00Z',
        revokedAt: null,
      },
    ];

    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      tokens: mockTokens,
    });

    const res = await callGetTokens();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      data: { tokens: mockTokens },
    });

    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/mcp/tokens/list',
      { userId: 'usr-123' },
      expect.objectContaining({ label: 'mcp /v1/mcp/tokens/list' })
    );
  });

  it('sidecar 故障时返回 500', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });

    callSidecarMock.mockResolvedValueOnce({
      ok: false,
      error: 'db query failed',
    });

    const res = await callGetTokens();
    expect(res.status).toBe(500);
  });
});

describe('POST /api/mcp/tokens (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function callCreateToken(body: unknown) {
    const { POST } = await import('@/app/api/mcp/tokens/route');
    const req = new NextRequest('http://localhost/api/mcp/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return POST(req);
  }

  it('未登录时返回 401', async () => {
    getSessionHelperMock.mockResolvedValue(null);
    const res = await callCreateToken({ name: 'Cursor' });
    expect(res.status).toBe(401);
  });

  it('名称为空时返回 400', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });
    const res = await callCreateToken({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('超过上限时返回 409', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });
    callSidecarMock.mockResolvedValueOnce({
      ok: false,
      code: 'MAX_TOKENS_EXCEEDED',
      error: 'Maximum active tokens limit reached (20). Please revoke unused tokens first.',
    });

    const res = await callCreateToken({ name: 'Cursor' });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('MAX_TOKENS_EXCEEDED');
  });

  it('正常创建 token 并返回 201 带明文', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });
    const mockCreated = {
      id: 'tok-123',
      name: 'Cursor',
      prefix: 'opgts_12',
      createdAt: '2026-09-22T00:00:00Z',
    };
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      token: mockCreated,
    });

    const res = await callCreateToken({ name: 'Cursor' });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.token.id).toBe('tok-123');
    expect(json.data.token.name).toBe('Cursor');
    expect(json.data.token.plainToken).toMatch(/^opgts_[a-f0-9]{32}$/);

    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/mcp/tokens/create',
      expect.objectContaining({
        userId: 'usr-123',
        name: 'Cursor',
      }),
      expect.objectContaining({ label: 'mcp /v1/mcp/tokens/create' })
    );
  });
});

describe('DELETE /api/mcp/tokens (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function callRevokeToken(url: string) {
    const { DELETE } = await import('@/app/api/mcp/tokens/route');
    const req = new NextRequest(url, { method: 'DELETE' });
    return DELETE(req);
  }

  it('未登录时返回 401', async () => {
    getSessionHelperMock.mockResolvedValue(null);
    const res = await callRevokeToken('http://localhost/api/mcp/tokens?id=tok-1');
    expect(res.status).toBe(401);
  });

  it('缺少 id 时返回 400', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });
    const res = await callRevokeToken('http://localhost/api/mcp/tokens');
    expect(res.status).toBe(400);
  });

  it('token 不存在时返回 404', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });
    callSidecarMock.mockResolvedValueOnce({
      ok: false,
      code: 'TOKEN_NOT_FOUND',
      error: 'Token not found or already revoked',
    });

    const res = await callRevokeToken('http://localhost/api/mcp/tokens?id=tok-missing');
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe('TOKEN_NOT_FOUND');
  });

  it('正常撤销 token 返回 200', async () => {
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'usr-123' },
      expires: '2099-01-01',
    });
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      revoked: true,
    });

    const res = await callRevokeToken('http://localhost/api/mcp/tokens?id=tok-1');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.revoked).toBe(true);

    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/mcp/tokens/revoke',
      { id: 'tok-1', userId: 'usr-123' },
      expect.objectContaining({ label: 'mcp /v1/mcp/tokens/revoke' })
    );
  });
});
