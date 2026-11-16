import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { oauthClientRegisterSchema } from '@/lib/schemas/oauth';

const createClientMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    oAuthClient: {
      create: (...args: unknown[]) => createClientMock(...args),
    },
  },
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
}));

describe('OAuth DCR redirect_uris validation (Item 9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createClientMock.mockResolvedValue({ id: 'client-1' });
  });

  describe('schema validation', () => {
    it('accepts https redirect_uris', () => {
      const res = oauthClientRegisterSchema.safeParse({
        redirect_uris: ['https://myapp.com/callback', 'https://auth.example.org/oauth'],
      });
      expect(res.success).toBe(true);
    });

    it('accepts loopback http redirect_uris (localhost / 127.0.0.1 / [::1])', () => {
      const res = oauthClientRegisterSchema.safeParse({
        redirect_uris: [
          'http://localhost:8080/callback',
          'http://127.0.0.1:3000/callback',
          'http://[::1]:9000/callback',
        ],
      });
      expect(res.success).toBe(true);
    });

    it('rejects plain non-loopback http redirect_uris', () => {
      const res = oauthClientRegisterSchema.safeParse({
        redirect_uris: ['http://evil.com/callback'],
      });
      expect(res.success).toBe(false);
    });

    it('rejects non-http/https protocols like ftp://', () => {
      const res = oauthClientRegisterSchema.safeParse({
        redirect_uris: ['ftp://x'],
      });
      expect(res.success).toBe(false);
    });

    it('🧪 [8.1.1.1] DCR 动态注册必须提供至少一个 https 或 127.0.0.1 回调地址（空或非法直接拦截）', () => {
      const res1 = oauthClientRegisterSchema.safeParse({ redirect_uris: [] });
      expect(res1.success).toBe(false);
      const res2 = oauthClientRegisterSchema.safeParse({});
      expect(res2.success).toBe(false);
      const res3 = oauthClientRegisterSchema.safeParse({ redirect_uris: ['http://evil.com/callback'] });
      expect(res3.success).toBe(false);
      const res4 = oauthClientRegisterSchema.safeParse({ redirect_uris: ['https://myapp.com/callback'] });
      expect(res4.success).toBe(true);
      const res5 = oauthClientRegisterSchema.safeParse({ redirect_uris: ['http://127.0.0.1:3000/callback'] });
      expect(res5.success).toBe(true);
    });
  });

  describe('🧪 [8.1.3.1] 精确比对 host/pathname，拦截 evil-example.com 子域名与路径伪装', () => {
    it('严格比对 redirect_uri，拦截子域名与路径冒用，放行合法 loopback 端口', async () => {
      const { isRedirectUriAllowed } = await import('@/lib/schemas/oauth');

      const registered = ['https://example.com/oauth/callback', 'http://127.0.0.1:8080/callback'];

      // 1. 精确匹配放行
      expect(isRedirectUriAllowed('https://example.com/oauth/callback', registered)).toBe(true);

      // 2. 拦截子域名冒用 (evil-example.com / sub.example.com)
      expect(isRedirectUriAllowed('https://evil-example.com/oauth/callback', registered)).toBe(false);
      expect(isRedirectUriAllowed('https://sub.example.com/oauth/callback', registered)).toBe(false);

      // 3. 拦截路径伪装或目录遍历
      expect(isRedirectUriAllowed('https://example.com/evil/callback', registered)).toBe(false);
      expect(isRedirectUriAllowed('https://example.com/oauth/callback/extra', registered)).toBe(false);

      // 4. Loopback 动态随机端口放行 (host 与 pathname 必须一致)
      expect(isRedirectUriAllowed('http://127.0.0.1:9999/callback', registered)).toBe(true);
      // Loopback 路径不一致依然拦截
      expect(isRedirectUriAllowed('http://127.0.0.1:9999/wrong-path', registered)).toBe(false);
    });
  });

  describe('route handler', () => {
    it('returns 400 when redirect_uris is missing or invalid', async () => {
      const { POST } = await import('@/app/api/auth/oauth/register/route');
      const req = new NextRequest('http://localhost/api/auth/oauth/register', {
        method: 'POST',
        body: JSON.stringify({ client_name: 'test-app' }),
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_client_metadata');
      expect(createClientMock).not.toHaveBeenCalled();
    });

    it('returns 201 and registers client when redirect_uris is valid', async () => {
      const { POST } = await import('@/app/api/auth/oauth/register/route');
      const req = new NextRequest('http://localhost/api/auth/oauth/register', {
        method: 'POST',
        body: JSON.stringify({
          client_name: 'test-app',
          redirect_uris: ['https://myapp.com/callback'],
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(201);
      expect(createClientMock).toHaveBeenCalledTimes(1);
    });
  });
});
