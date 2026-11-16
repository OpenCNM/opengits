import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { forwardSse, sseGatewayEnabled } from '@/lib/sse/sse-gateway-driver';
import { ENGINE_CONFIG } from '@/lib/config';

describe('SSE Gateway Driver (TS 分发与 Fail-Closed 网关独占)', () => {
  const originalGatewayUrl = ENGINE_CONFIG.endpoints.sseGateway;
  const originalInternalToken = process.env.INTERNAL_API_TOKEN;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
  });

  afterEach(() => {
    ENGINE_CONFIG.endpoints.sseGateway = originalGatewayUrl;
    if (originalInternalToken !== undefined) {
      process.env.INTERNAL_API_TOKEN = originalInternalToken;
    } else {
      delete process.env.INTERNAL_API_TOKEN;
    }
  });

  // [1.19.3.1] 网关未配置时执行严格 Fail-Closed 防御（503）
  it('[1.19.3.1] 未配置 SSE_GATEWAY_URL 时 sseGatewayEnabled=false 且 forwardSse 返回 503 Fail-Closed', async () => {
    ENGINE_CONFIG.endpoints.sseGateway = '';
    expect(sseGatewayEnabled()).toBe(false);

    const req = new Request('http://localhost:3000/api/notifications/stream');
    const res = await forwardSse(req, '/api/notifications/stream');

    expect(res.status).toBe(503);
    expect(await res.text()).toContain('SSE Gateway is not configured (Fail-Closed)');
  });

  // [1.19.1.1] 网关转发透传与 Last-Event-ID 游标传递
  it('[1.19.1.1] 配置 SSE_GATEWAY_URL 且网关返回 200 时成功流式透传（含 last-event-id 传递）', async () => {
    ENGINE_CONFIG.endpoints.sseGateway = 'http://localhost:8082';
    expect(sseGatewayEnabled()).toBe(true);

    const mockFetch = vi.fn().mockResolvedValue(
      new Response('data: {"unreadCount":1}\n\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const req = new Request('http://localhost:3000/api/notifications/stream?since=10', {
      headers: {
        cookie: 'next-auth.session-token=mock-token',
        'last-event-id': '42',
      },
    });

    const res = await forwardSse(
      req,
      '/api/notifications/stream',
      { userId: 'user-abc' },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toBe('data: {"unreadCount":1}\n\n');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [callUrl, callInit] = mockFetch.mock.calls[0];
    expect(callUrl).toBe('http://localhost:8082/api/notifications/stream?since=10');
    expect(callInit.headers.get('cookie')).toBe('next-auth.session-token=mock-token');
    expect(callInit.headers.get('last-event-id')).toBe('42');
    expect(callInit.headers.get('x-internal-token')).toBe('test-internal-token');
    expect(callInit.headers.get('x-user-id')).toBe('user-abc');
  });

  // [1.19.3.1] 网关 5xx 故障时 Fail-Closed 返回上游状态，严禁本地伪降级
  it('[1.19.3.1] 网关返回 5xx 故障时 Fail-Closed 原样返回上游错误响应', async () => {
    ENGINE_CONFIG.endpoints.sseGateway = 'http://localhost:8082';

    const mockFetch = vi.fn().mockResolvedValue(
      new Response('Gateway 502 Bad Gateway', {
        status: 502,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const req = new Request('http://localhost:3000/api/ingest-jobs/job-1/events');
    const res = await forwardSse(req, '/api/ingest-jobs/job-1/events');

    expect(res.status).toBe(502);
    expect(await res.text()).toBe('Gateway 502 Bad Gateway');
  });

  // [1.19.3.1] 网关网络异常（如拒绝连接）时 Fail-Closed 返回 502
  it('[1.19.3.1] 网关网络异常（如拒绝连接）时 Fail-Closed 返回 502', async () => {
    ENGINE_CONFIG.endpoints.sseGateway = 'http://localhost:8082';

    const mockFetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8082'));
    vi.stubGlobal('fetch', mockFetch);

    const req = new Request('http://localhost:3000/api/mcp/active-clients/stream');
    const res = await forwardSse(req, '/api/mcp/active-clients/stream');

    expect(res.status).toBe(502);
    expect(await res.text()).toContain('SSE Gateway Unavailable (Fail-Closed)');
  });

  // [1.19.3.2] 凭证注入与参数转发
  it('[1.19.3.2] forwardSse 正确注入 x-internal-token 和 x-user-id 凭据', async () => {
    ENGINE_CONFIG.endpoints.sseGateway = 'http://localhost:8082';

    const mockFetch = vi.fn().mockResolvedValue(
      new Response('data: {}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const req = new Request('http://localhost:3000/api/notifications/stream', {
      headers: {
        authorization: 'Bearer token-xyz',
      },
    });

    const res = await forwardSse(req, '/api/notifications/stream', { userId: 'user-789' });

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, callInit] = mockFetch.mock.calls[0];
    expect(callInit.headers.get('x-internal-token')).toBe('test-internal-token');
    expect(callInit.headers.get('x-user-id')).toBe('user-789');
    expect(callInit.headers.get('authorization')).toBe('Bearer token-xyz');
  });

  // [1.19.2.2] 鉴权透传（非 5xx 错误原样下发）
  it('[1.19.2.2] 网关返回 401/403/404 业务鉴权错误时原样返回客户端', async () => {
    ENGINE_CONFIG.endpoints.sseGateway = 'http://localhost:8082';

    const mockFetch = vi.fn().mockResolvedValue(
      new Response('Unauthorized', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const req = new Request('http://localhost:3000/api/notifications/stream');
    const res = await forwardSse(req, '/api/notifications/stream');

    expect(res.status).toBe(401);
    expect(await res.text()).toBe('Unauthorized');
  });

  // 注：[1.19.1.2]（心跳保活与空闲连接清理）与 [1.19.2.1]（JobSnapshotHub 多观众单轮询 DB 聚合）
  // 经 services/worker-sidecar/internal/sse/sse_test.go (TestSSEWriter_Heartbeat & TestJobSnapshotHub_Fanout)
  // 原生 Go 单测深度验证。

// [安全护栏] 外部请求携带的 x-user-id / x-internal-token 永不透传：
// 转发头是白名单构造（cookie/authorization/last-event-id/accept），
// 身份头只从服务端鉴权结果注入——外部注入必须被丢弃，SSE 冒充面为零。
it('[安全护栏] 入站请求伪造的 x-user-id / x-internal-token 被白名单丢弃', async () => {
  ENGINE_CONFIG.endpoints.sseGateway = 'http://localhost:8082';

  const mockFetch = vi.fn().mockResolvedValue(
    new Response('data: {}\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    }),
  );
  vi.stubGlobal('fetch', mockFetch);

  const req = new Request('http://localhost:3000/api/notifications/stream', {
    headers: {
      // 恶意外部注入：冒充他人身份 + 伪造内部令牌
      'x-user-id': 'victim-user',
      'x-internal-token': 'forged-token',
      'x-forwarded-for': '1.2.3.4',
    },
  });

  const res = await forwardSse(req, '/api/notifications/stream', { userId: 'real-user' });
  expect(res.status).toBe(200);

  const [, callInit] = mockFetch.mock.calls[0];
  expect(callInit.headers.get('x-user-id')).toBe('real-user');
  expect(callInit.headers.get('x-internal-token')).toBe('test-internal-token');
  expect(callInit.headers.get('x-forwarded-for')).toBeNull();
});
});
