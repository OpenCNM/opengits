import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: vi.fn(),
  getAdminUserHelper: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
  clientIpFromRequest: vi.fn().mockReturnValue('203.0.113.9'),
}));

vi.mock('@/lib/observability/errors', () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

import { getSessionHelper, getAdminUserHelper } from '@/lib/auth-helper';
import { checkRateLimit } from '@/lib/rate-limit';
import { captureError } from '@/lib/observability/errors';

const mockSession = getSessionHelper as ReturnType<typeof vi.fn>;
const mockAdmin = getAdminUserHelper as ReturnType<typeof vi.fn>;
const mockRateLimit = checkRateLimit as ReturnType<typeof vi.fn>;

function jsonRequest(url: string, body?: unknown, method = 'POST'): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : {}),
  });
}

describe('defineRoute（路由统一封装）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimit.mockResolvedValue(true);
  });

  it('user 鉴权：未登录返回 401 失败信封', async () => {
    mockSession.mockResolvedValue(null);
    const handler = defineRoute({ scope: 'test', auth: 'user', handler: () => ok({ ok: true }) });

    const res = await handler(jsonRequest('/api/t', {}, 'POST'), { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.code).toBe('UNAUTHORIZED');
  });

  it('user 鉴权：已登录注入 userId，成功返回 data 信封', async () => {
    mockSession.mockResolvedValue({ user: { id: 'u1', email: 'a@b.c' } });
    let seenUserId: string | null = null;
    const handler = defineRoute({
      scope: 'test',
      auth: 'user',
      handler: (ctx) => {
        seenUserId = ctx.userId;
        return ok({ echo: ctx.userId });
      },
    });

    const res = await handler(jsonRequest('/api/t', {}, 'POST'), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ echo: 'u1' });
    expect(seenUserId).toBe('u1');
  });

  it('admin 鉴权：非管理员 403；管理员注入 adminEmail', async () => {
    mockAdmin.mockResolvedValue(null);
    const denied = defineRoute({ scope: 'test', auth: 'admin', handler: () => ok('x') });
    const deniedRes = await denied(jsonRequest('/api/t', undefined, 'GET'), { params: Promise.resolve({}) });
    expect(deniedRes.status).toBe(403);

    mockAdmin.mockResolvedValue({ email: 'admin@opengits.org', isActive: true });
    const allowed = defineRoute({
      scope: 'test',
      auth: 'admin',
      handler: (ctx) => ok({ admin: ctx.adminEmail }),
    });
    const allowedRes = await allowed(jsonRequest('/api/t', undefined, 'GET'), { params: Promise.resolve({}) });
    const json = await allowedRes.json();
    expect(json.data).toEqual({ admin: 'admin@opengits.org' });
  });

  it('bodySchema：非法 body 返回 400 + VALIDATION_ERROR；合法 body 传给 handler', async () => {
    mockSession.mockResolvedValue({ user: { id: 'u1' } });
    const handler = defineRoute({
      scope: 'test',
      auth: 'user',
      bodySchema: z.object({ name: z.string().min(1) }),
      handler: (ctx) => ok({ name: ctx.body.name }),
    });

    const bad = await handler(jsonRequest('/api/t', { name: '' }), { params: Promise.resolve({}) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('VALIDATION_ERROR');

    const good = await handler(jsonRequest('/api/t', { name: 'demo' }), { params: Promise.resolve({}) });
    expect((await good.json()).data).toEqual({ name: 'demo' });
  });

  it('ApiError：按 status/code/detail 映射', async () => {
    mockSession.mockResolvedValue({ user: { id: 'u1' } });
    const handler = defineRoute({
      scope: 'test',
      auth: 'user',
      handler: () => {
        throw new ApiError(404, 'Repo not found', { code: 'REPO_NOT_FOUND', detail: 'owner/repo' });
      },
    });

    const res = await handler(jsonRequest('/api/t', undefined, 'GET'), { params: Promise.resolve({}) });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json).toMatchObject({ success: false, error: 'Repo not found', code: 'REPO_NOT_FOUND', detail: 'owner/repo' });
  });

  it('未知异常：500 泛化响应 + captureError 记录（不泄漏内部消息）', async () => {
    mockSession.mockResolvedValue({ user: { id: 'u1' } });
    const handler = defineRoute({
      scope: 'test.scope',
      auth: 'user',
      handler: () => {
        throw new Error('internal secret detail');
      },
    });

    const res = await handler(jsonRequest('/api/t', undefined, 'GET'), { params: Promise.resolve({}) });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('Internal Server Error');
    expect(json.error).not.toContain('secret');
    expect(captureError).toHaveBeenCalled();
  });

  it('限流拒绝：429 + RATE_LIMITED', async () => {
    mockSession.mockResolvedValue({ user: { id: 'u1' } });
    mockRateLimit.mockResolvedValue(false);
    const handler = defineRoute({
      scope: 'test',
      auth: 'user',
      rateLimit: { limit: 1, windowMs: 60_000 },
      handler: () => ok('never'),
    });

    const res = await handler(jsonRequest('/api/t', undefined, 'GET'), { params: Promise.resolve({}) });
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('RATE_LIMITED');
  });

  it('动态段解包：params Promise 被 await 后注入 handler', async () => {
    mockSession.mockResolvedValue({ user: { id: 'u1' } });
    const handler = defineRoute<{ id: string }>({
      scope: 'test',
      auth: 'user',
      handler: (ctx) => ok(ctx.params),
    });

    const res = await handler(jsonRequest('/api/t/abc', undefined, 'GET'), {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect((await res.json()).data).toEqual({ id: 'abc' });
  });

  it('handler 返回 NextResponse 时原样透传（流式逃生舱）', async () => {
    mockSession.mockResolvedValue({ user: { id: 'u1' } });
    const passthrough = NextResponse.json({ custom: 'shape' }, { status: 201 });
    const handler = defineRoute({ scope: 'test', auth: 'user', handler: () => passthrough });

    const res = await handler(jsonRequest('/api/t', undefined, 'GET'), { params: Promise.resolve({}) });
    expect(res.status).toBe(201);
    expect((await res.json()).custom).toBe('shape');
  });

  it('handler 返回 void：200 + data:null', async () => {
    mockSession.mockResolvedValue({ user: { id: 'u1' } });
    const handler = defineRoute({ scope: 'test', auth: 'user', handler: () => undefined });

    const res = await handler(jsonRequest('/api/t', undefined, 'GET'), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toBeNull();
  });
});
