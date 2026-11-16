import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const callSidecarMock = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

const tokenFindManyMock = vi.fn();
const tokenCountMock = vi.fn();
const tokenCreateMock = vi.fn();
const tokenUpdateManyMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    mcpApiToken: {
      findMany: (...args: unknown[]) => tokenFindManyMock(...args),
      count: (...args: unknown[]) => tokenCountMock(...args),
      create: (...args: unknown[]) => tokenCreateMock(...args),
      updateMany: (...args: unknown[]) => tokenUpdateManyMock(...args),
    },
  },
}));

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: vi.fn().mockResolvedValue({
    user: { id: 'usr_test_123', email: 'test@example.com' },
  }),
}));

describe('MCP Tokens Route Handler (Fix 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/mcp/tokens: 返回用户的所有 token 列表 (defineRoute envelope)', async () => {
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      tokens: [
        { id: 'tok_1', name: 'Claude Code', prefix: 'og_live_', createdAt: new Date().toISOString(), revokedAt: null },
      ],
    });

    const { GET } = await import('@/app/api/mcp/tokens/route');
    const req = new NextRequest('http://localhost:3000/api/mcp/tokens');
    const res = await GET(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.tokens).toHaveLength(1);
    expect(json.data.tokens[0].name).toBe('Claude Code');
  });

  it('POST /api/mcp/tokens: 创建 Token 并在超过最大上限时返回 409 ApiError', async () => {
    callSidecarMock.mockResolvedValueOnce({
      ok: false,
      code: 'MAX_TOKENS_EXCEEDED',
      error: 'Maximum active tokens limit reached (20). Please revoke unused tokens first.',
    });

    const { POST } = await import('@/app/api/mcp/tokens/route');
    const req = new NextRequest('http://localhost:3000/api/mcp/tokens', {
      method: 'POST',
      body: JSON.stringify({ name: 'Cursor Token' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(409);

    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe('MAX_TOKENS_EXCEEDED');
  });

  it('DELETE /api/mcp/tokens: 软撤销 Token', async () => {
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      revoked: true,
    });

    const { DELETE } = await import('@/app/api/mcp/tokens/route');
    const req = new NextRequest('http://localhost:3000/api/mcp/tokens?id=tok_1', {
      method: 'DELETE',
    });
    const res = await DELETE(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.revoked).toBe(true);
  });

  it('GET /api/mcp/tokens/default: 已有加密 Token 时解密返回', async () => {
    const { encryptApiKey } = await import('@/lib/crypto/api-key-cipher');
    const plain = 'opgts_1234567890abcdef1234567890abcdef';
    tokenFindManyMock.mockResolvedValueOnce([
      { id: 'tok_1', name: 'Default', prefix: 'opgts_12', encryptedToken: encryptApiKey(plain), revokedAt: null },
    ]);

    const { GET } = await import('@/app/api/mcp/tokens/default/route');
    const req = new NextRequest('http://localhost:3000/api/mcp/tokens/default');
    const res = await GET(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.token).toBe(plain);
    expect(json.data.name).toBe('Default');
  });

  it('GET /api/mcp/tokens/default: 无可用 Token 时自动初始化并返回', async () => {
    tokenFindManyMock.mockResolvedValueOnce([]);
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      token: {
        id: 'tok_new',
        name: 'Default',
        prefix: 'opgts_12',
      },
    });

    const { GET } = await import('@/app/api/mcp/tokens/default/route');
    const req = new NextRequest('http://localhost:3000/api/mcp/tokens/default');
    const res = await GET(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.token).toMatch(/^opgts_[a-f0-9]{32}$/);
    expect(json.data.name).toBe('Default');
  });
});