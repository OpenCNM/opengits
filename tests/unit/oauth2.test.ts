import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { isRedirectUriAllowed } from '@/lib/schemas/oauth';
import { createHash, randomBytes } from 'node:crypto';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const oAuthClientCreateMock = vi.fn();
const oAuthClientFindUniqueMock = vi.fn();
const oAuthAuthCodeCreateMock = vi.fn();
const oAuthAuthCodeDeleteMock = vi.fn();
const oAuthAuthCodeDeleteManyMock = vi.fn();
const mcpApiTokenCreateMock = vi.fn();
const callSidecarMock = vi.fn();
const getSessionMock = vi.fn();

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    oAuthClient: {
      create: (...args: unknown[]) => oAuthClientCreateMock(...args),
      findUnique: (...args: unknown[]) => oAuthClientFindUniqueMock(...args),
    },
    oAuthAuthCode: {
      create: (...args: unknown[]) => oAuthAuthCodeCreateMock(...args),
      delete: (...args: unknown[]) => oAuthAuthCodeDeleteMock(...args),
      deleteMany: (...args: unknown[]) => oAuthAuthCodeDeleteManyMock(...args),
    },
    mcpApiToken: {
      create: (...args: unknown[]) => mcpApiTokenCreateMock(...args),
    },
  },
}));

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: () => getSessionMock(),
}));

describe('isRedirectUriAllowed 校验', () => {
  it('精确匹配：完全相同的 URI 放行', () => {
    expect(isRedirectUriAllowed('https://app.example.com/callback', ['https://app.example.com/callback'])).toBe(true);
    expect(isRedirectUriAllowed('cursor://auth/callback', ['cursor://auth/callback'])).toBe(true);
  });

  it('非白名单 URI 拦截', () => {
    expect(isRedirectUriAllowed('https://evil.com/callback', ['https://app.example.com/callback'])).toBe(false);
  });

  it('RFC 8252 Loopback 动态端口：localhost 与 127.0.0.1 任意有效端口均放行', () => {
    const whitelist = ['http://localhost/callback', 'http://127.0.0.1/callback'];
    expect(isRedirectUriAllowed('http://localhost:54321/callback', whitelist)).toBe(true);
    expect(isRedirectUriAllowed('http://127.0.0.1:8080/callback', whitelist)).toBe(true);
    // path 不一致仍需拦截
    expect(isRedirectUriAllowed('http://localhost:54321/other', whitelist)).toBe(false);
  });

  it('非 Loopback 地址不允许任意端口变换', () => {
    expect(isRedirectUriAllowed('https://app.example.com:8443/callback', ['https://app.example.com/callback'])).toBe(false);
  });
});

describe('OAuth 2.1 注册、授权与 Token 兑换', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue(null);
  });

  it('POST /api/auth/oauth/register：持久化注册客户端', async () => {
    const { POST: registerPost } = await import('@/app/api/auth/oauth/register/route');
    oAuthClientCreateMock.mockResolvedValue({});

    const req = new NextRequest('http://localhost/api/auth/oauth/register', {
      method: 'POST',
      body: JSON.stringify({
        client_name: 'Cursor IDE',
        redirect_uris: ['http://localhost/callback'],
      }),
      headers: { 'content-type': 'application/json' },
    });

    const res = await registerPost(req);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.client_id).toMatch(/^opgts-client-/);
    expect(json.client_name).toBe('Cursor IDE');
    expect(oAuthClientCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Cursor IDE',
          redirectUris: ['http://localhost/callback'],
        }),
      })
    );
  });

  it('GET /api/auth/oauth/authorize：未注册客户端或非法 redirect_uri 返回 400', async () => {
    const { GET: authGet } = await import('@/app/api/auth/oauth/authorize/route');
    oAuthClientFindUniqueMock.mockResolvedValue(null);

    const req = new NextRequest(
      'http://localhost/api/auth/oauth/authorize?client_id=bad-client&redirect_uri=http://localhost/cb&code_challenge=xyz&code_challenge_method=S256'
    );
    const res = await authGet(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('unauthorized_client');
  });

  it('POST /api/auth/oauth/token：PKCE 匹配且一次性消费成功', async () => {
    const { POST: tokenPost } = await import('@/app/api/auth/oauth/token/route');
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = base64url(createHash('sha256').update(verifier).digest());

    // 模拟数据库内存在的有效授权码，delete 返回该行（原子消费）
    oAuthAuthCodeDeleteMock.mockResolvedValueOnce({
      code: 'code-123',
      clientId: 'client-1',
      userId: 'user-1',
      codeChallenge: challenge,
      redirectUri: 'http://localhost/cb',
      expiresAt: new Date(Date.now() + 300_000),
    });

    callSidecarMock.mockResolvedValue({
      ok: true,
      token: {
        id: 'token-row-1',
        createdAt: new Date().toISOString(),
      },
    });

    const req = new NextRequest('http://localhost/api/auth/oauth/token', {
      method: 'POST',
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: 'code-123',
        code_verifier: verifier,
        client_id: 'client-1',
        redirect_uri: 'http://localhost/cb',
      }),
      headers: { 'content-type': 'application/json' },
    });

    const res = await tokenPost(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.token_type).toBe('Bearer');
    expect(json.access_token).toMatch(/^opgts_/);
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/mcp/tokens/create',
      expect.objectContaining({
        userId: 'user-1',
        name: 'OAuth:client-1',
      }),
      expect.anything()
    );

    // 模拟重复使用同一个 code：delete 找不到（已被删除），返回 400 invalid_grant
    oAuthAuthCodeDeleteMock.mockResolvedValueOnce(null);
    const retryReq = new NextRequest('http://localhost/api/auth/oauth/token', {
      method: 'POST',
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: 'code-123',
        code_verifier: verifier,
        client_id: 'client-1',
        redirect_uri: 'http://localhost/cb',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const retryRes = await tokenPost(retryReq);
    expect(retryRes.status).toBe(400);
    const retryJson = await retryRes.json();
    expect(retryJson.error).toBe('invalid_grant');
  });
});