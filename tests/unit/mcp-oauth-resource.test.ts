import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * MCP 2026-07-28 规范的 OAuth 增量对齐测试：
 * - RFC 8707 resource 指示器校验（跨源 → invalid_target）
 * - RFC 9207 授权响应 iss 参数
 * - RFC 9728 受保护资源发现元数据
 */

vi.mock('@/lib/db', () => ({
  prisma: {
    oAuthClient: { findUnique: vi.fn() },
    oAuthAuthCode: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({}) },
  },
}));

const sessionMock = vi.hoisted(() => ({ user: { id: 'u-oauth-1' } }));
vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: vi.fn(async () => sessionMock.user ? sessionMock : null),
}));

import { GET as GETAuthorize, POST as POSTAuthorize } from '@/app/api/auth/oauth/authorize/route';
import { GET as GETProtectedResource } from '@/app/.well-known/oauth-protected-resource/route';
import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

const CLIENT = { id: 'client-1', name: 'Test CLI', redirectUris: ['https://cli.example/callback'] };

function authorizeURL(params: Record<string, string>): NextRequest {
  const qs = new URLSearchParams(params).toString();
  return new NextRequest(`http://localhost:3000/api/auth/oauth/authorize?${qs}`);
}

function authorizeForm(params: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

describe('RFC 9728 受保护资源发现元数据', () => {
  it('返回 resource 与 authorization_servers（与 issuer 同源同口径）', async () => {
    const res = await GETProtectedResource();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBeTruthy();
    expect(Array.isArray(body.authorization_servers)).toBe(true);
    expect(body.authorization_servers[0]).toBe(body.resource);
    expect(body.scopes_supported).toContain('mcp');
  });
});

describe('RFC 8707 resource 指示器校验', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.oAuthClient.findUnique).mockResolvedValue(CLIENT as any);
  });

  const base = {
    client_id: 'client-1',
    redirect_uri: 'https://cli.example/callback',
    code_challenge: 'a'.repeat(48),
    code_challenge_method: 'S256',
    state: 'xyz',
  };

  it('跨源 resource → 302 重定向携带 error=invalid_target', async () => {
    const res = await GETAuthorize(authorizeURL({
      ...base,
      resource: 'https://evil.example/api/mcp',
    }));
    expect([302, 307]).toContain(res.status);
    const loc = res.headers.get('location') || '';
    expect(loc).toContain('error=invalid_target');
    expect(loc).toContain('state=xyz');
  });

  it('同源 resource（含任意 MCP 端点路径）→ 正常进入同意页', async () => {
    const res = await GETAuthorize(authorizeURL({
      ...base,
      resource: 'http://localhost:3000/api/mcp/vercel/next.js',
    }));
    expect(res.status).toBe(200);
    expect(prisma.oAuthClient.findUnique).toHaveBeenCalled();
  });

  it('未携带 resource → 合法（可选参数）', async () => {
    const res = await GETAuthorize(authorizeURL(base));
    expect(res.status).toBe(200);
  });

  it('POST 直发跨源 resource（绕过同意页）→ 400 invalid_target', async () => {
    const res = await POSTAuthorize(authorizeForm({
      ...base,
      resource: 'https://evil.example/api/mcp',
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_target');
  });
});

describe('RFC 9207 授权响应 iss 参数', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.oAuthClient.findUnique).mockResolvedValue(CLIENT as any);
    vi.mocked(prisma.oAuthAuthCode.create).mockResolvedValue({} as any);
  });

  it('POST 成功重定向携带 iss（与发现元数据 issuer 一致）', async () => {
    const res = await POSTAuthorize(authorizeForm({
      client_id: 'client-1',
      redirect_uri: 'https://cli.example/callback',
      code_challenge: 'a'.repeat(48),
      state: 's1',
    }));
    expect([302, 307]).toContain(res.status);
    const loc = res.headers.get('location') || '';
    expect(loc).toContain('code=');
    expect(loc).toMatch(/iss=http%3A%2F%2Flocalhost%3A3000|iss=http:\/\/localhost:3000/);
  });
});
