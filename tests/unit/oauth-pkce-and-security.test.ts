import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';

const oAuthAuthCodeDeleteMock = vi.fn();
const oAuthClientFindUniqueMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    oAuthAuthCode: {
      delete: (...args: unknown[]) => oAuthAuthCodeDeleteMock(...args),
    },
    oAuthClient: {
      findUnique: (...args: unknown[]) => oAuthClientFindUniqueMock(...args),
    },
  },
}));

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: vi.fn().mockResolvedValue({ user: { id: 'user-123' } }),
}));

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('M08 OAuth 2.1 PKCE and Security Guards (Unit 8.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oAuthClientFindUniqueMock.mockResolvedValue({
      id: 'client-safe',
      name: 'Safe Client',
      redirectUris: ['https://example.com/callback'],
    });
  });

  it('🧪 [8.1.2.1] 授权码兑换首步原子消费删除（prisma.oAuthAuthCode.delete({ where: { code } }) 防重放攻击）', async () => {
    const { consumeAuthCode } = await import('@/app/api/auth/oauth/authorize/route');

    const verifier = 'my-super-secret-code-verifier-string-1234567890';
    const challenge = base64url(createHash('sha256').update(verifier).digest());

    const fakeCodeRow = {
      code: 'code-unique-xyz',
      clientId: 'client-safe',
      userId: 'user-123',
      codeChallenge: challenge,
      redirectUri: 'https://example.com/callback',
      expiresAt: new Date(Date.now() + 60_000),
    };

    // 第一次兑换：原子 delete 命中 1 行，兑换成功
    oAuthAuthCodeDeleteMock.mockResolvedValueOnce(fakeCodeRow);
    const firstResult = await consumeAuthCode('code-unique-xyz', verifier);
    expect(firstResult).not.toBeNull();
    expect(firstResult?.userId).toBe('user-123');
    expect(oAuthAuthCodeDeleteMock).toHaveBeenCalledWith({
      where: { code: 'code-unique-xyz' },
    });

    // 第二次并发或重放兑换：因已被首个请求原子删除，delete 抛错或返回 null，兑换失败
    oAuthAuthCodeDeleteMock.mockRejectedValueOnce(new Error('Record to delete does not exist.'));
    const secondResult = await consumeAuthCode('code-unique-xyz', verifier);
    expect(secondResult).toBeNull();

    // 3. 过期授权码拦截：即使查到了行，但 expiresAt 已过期 -> 拒绝并返回 null
    oAuthAuthCodeDeleteMock.mockResolvedValueOnce({
      ...fakeCodeRow,
      expiresAt: new Date(Date.now() - 5000), // 已过期 5 秒
    });
    const expiredResult = await consumeAuthCode('code-unique-xyz', verifier);
    expect(expiredResult).toBeNull();

    // 4. PKCE verifier 校验失败：传入错误的 verifier -> 拒绝并返回 null
    oAuthAuthCodeDeleteMock.mockResolvedValueOnce(fakeCodeRow);
    const wrongVerifierResult = await consumeAuthCode('code-unique-xyz', 'completely-wrong-verifier-string');
    expect(wrongVerifierResult).toBeNull();

    // 5. 空入参保护
    expect(await consumeAuthCode('', verifier)).toBeNull();
    expect(await consumeAuthCode('code-xyz', '')).toBeNull();
  });

  it('🧪 [8.1.2.2] OAuth 2.1 强制仅允许 code_challenge_method === "S256"，拒绝 plain 降级', async () => {
    const { GET } = await import('@/app/api/auth/oauth/authorize/route');

    // 尝试以 plain 方法发起请求
    const plainReq = new NextRequest(
      'http://localhost:3000/api/auth/oauth/authorize?client_id=client-safe&redirect_uri=https://example.com/callback&code_challenge=plain-challenge&code_challenge_method=plain&state=xyz'
    );

    const plainRes = await GET(plainReq);
    expect(plainRes.status).toBe(400);
    const plainJson = await plainRes.json();
    expect(plainJson.error).toBe('invalid_request');

    // 尝试未指定 code_challenge_method 请求
    const emptyReq = new NextRequest(
      'http://localhost:3000/api/auth/oauth/authorize?client_id=client-safe&redirect_uri=https://example.com/callback&code_challenge=xyz&state=xyz'
    );
    const emptyRes = await GET(emptyReq);
    expect(emptyRes.status).toBe(400);

    // 仅合法的 S256 请求被允许放行
    const s256Req = new NextRequest(
      'http://localhost:3000/api/auth/oauth/authorize?client_id=client-safe&redirect_uri=https://example.com/callback&code_challenge=safe-challenge&code_challenge_method=S256&state=xyz'
    );
    const s256Res = await GET(s256Req);
    expect(s256Res.status).toBe(200);
  });

  it('🧪 [8.1.4.1] client_name 与 state 参数经过 escapeHtml 转义，杜绝 XSS 注入', async () => {
    const { GET } = await import('@/app/api/auth/oauth/authorize/route');

    // 客户端名称与 state 中包含恶意的 XSS 注入向量
    const xssClientName = '<script>alert("XSS")</script>&evil=1';
    const xssState = '"><svg onload=alert(document.cookie)>';

    oAuthClientFindUniqueMock.mockResolvedValueOnce({
      id: 'client-xss',
      name: xssClientName,
      redirectUris: ['https://example.com/callback'],
    });

    const xssReq = new NextRequest(
      `http://localhost:3000/api/auth/oauth/authorize?client_id=client-xss&redirect_uri=https://example.com/callback&code_challenge=valid-challenge&code_challenge_method=S256&state=${encodeURIComponent(xssState)}`
    );

    const res = await GET(xssReq);
    expect(res.status).toBe(200);

    const html = await res.text();

    // 原始危险标签必须不存在
    expect(html).not.toContain('<script>alert("XSS")</script>');
    expect(html).not.toContain('<svg onload=alert(document.cookie)>');

    // 必须被完全转义为 HTML 实体，杜绝反射型 XSS
    expect(html).toContain('alert(&amp;quot;XSS&amp;quot;)');
    expect(html).toContain('&quot;&gt;&lt;svg onload=alert(document.cookie)&gt;');
  });

  it('🧪 [8.1.3.1] 重定向 URI 白名单校验（拦截 UserInfo 凭据、URL Fragment、协议混淆与未注册域）', async () => {
    const { isRedirectUriAllowed, isValidRedirectUri } = await import('@/lib/schemas/oauth');

    const registered = [
      'https://app.example.com/oauth/callback',
      'http://127.0.0.1:8080/callback',
      'http://localhost:3000/auth',
    ];

    // 1. 完全精确匹配
    expect(isRedirectUriAllowed('https://app.example.com/oauth/callback', registered)).toBe(true);

    // 2. Loopback 允许合法动态端口
    expect(isRedirectUriAllowed('http://127.0.0.1:9999/callback', registered)).toBe(true);
    expect(isRedirectUriAllowed('http://localhost:54321/auth', registered)).toBe(true);

    // 3. 拦截 UserInfo 凭据注入 (RFC 8252 §7.3)
    expect(isRedirectUriAllowed('http://attacker:secret@127.0.0.1:8080/callback', registered)).toBe(false);
    expect(isValidRedirectUri('http://attacker:secret@127.0.0.1:8080/callback')).toBe(false);
    expect(isValidRedirectUri('https://user:pass@app.example.com/callback')).toBe(false);

    // 4. 拦截 Fragment 组件 (RFC 6749 §3.1.2)
    expect(isRedirectUriAllowed('https://app.example.com/oauth/callback#evil', registered)).toBe(false);
    expect(isRedirectUriAllowed('http://127.0.0.1:8080/callback#token=123', registered)).toBe(false);
    expect(isValidRedirectUri('https://app.example.com/oauth/callback#section')).toBe(false);

    // 5. 拦截未注册域名或子域名伪装
    expect(isRedirectUriAllowed('https://evil-example.com/oauth/callback', registered)).toBe(false);
    expect(isRedirectUriAllowed('https://app.example.com.evil.com/oauth/callback', registered)).toBe(false);

    // 6. 拦截非 loopback 协议动态端口 / pathname 篡改
    expect(isRedirectUriAllowed('https://app.example.com:8443/oauth/callback', registered)).toBe(false);
    expect(isRedirectUriAllowed('http://127.0.0.1:8080/wrong-path', registered)).toBe(false);
  });
});
