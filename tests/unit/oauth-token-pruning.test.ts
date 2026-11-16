import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const tokenFindManyMock = vi.fn();
const clientFindUniqueMock = vi.fn();
const callSidecarMock = vi.fn();

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    mcpApiToken: {
      findMany: (...args: unknown[]) => tokenFindManyMock(...args),
    },
    oAuthClient: {
      findUnique: (...args: unknown[]) => clientFindUniqueMock(...args),
    },
  },
}));

vi.mock('@/app/api/auth/oauth/authorize/route', () => ({
  consumeAuthCode: vi.fn().mockResolvedValue({
    clientId: 'test-client',
    userId: 'user-123',
    codeChallenge: 'chall',
    redirectUri: 'http://localhost/callback',
  }),
}));

describe('OAuth Token Self-Healing Pruning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('🧪 [8.1.5.1] POST /api/auth/oauth/token: 同客户端活跃 Token 超限（20+）时原子淘汰最老有效 Token', async () => {
    const existing = Array.from({ length: 20 }, (_, i) => ({
      id: `tok_${i}`,
      name: i === 0 ? 'OAuth:test-client' : `Token_${i}`,
    }));
    tokenFindManyMock.mockResolvedValueOnce(existing);
    callSidecarMock.mockImplementation(async (endpoint: string) => {
      if (endpoint === '/v1/mcp/tokens/revoke') {
        return { ok: true, revoked: true };
      }
      if (endpoint === '/v1/mcp/tokens/create') {
        return { ok: true, token: { id: 'tok_new', createdAt: new Date().toISOString() } };
      }
      return { ok: true };
    });

    const { POST } = await import('@/app/api/auth/oauth/token/route');
    const req = new NextRequest('http://localhost:3000/api/auth/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: 'valid-code',
        code_verifier: 'valid-verifier',
        client_id: 'test-client',
        redirect_uri: 'http://localhost/callback',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/mcp/tokens/revoke',
      expect.objectContaining({
        id: 'tok_0',
        userId: 'user-123',
      }),
      expect.anything()
    );
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/mcp/tokens/create',
      expect.objectContaining({
        userId: 'user-123',
        name: 'OAuth:test-client',
      }),
      expect.anything()
    );
  });
});