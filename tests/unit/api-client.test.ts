import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch, ApiClientError, api } from '@/lib/api/client';

const toastAdd = vi.fn();
vi.mock('@/components/ui/toast', () => ({
  toastManager: {
    add: (...args: unknown[]) => toastAdd(...args),
  },
}));

function jsonResponse(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('apiFetch（客户端统一封装）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    toastAdd.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('成功信封：解包返回 data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { id: 'n1' } })));
    await expect(apiFetch('/api/x')).resolves.toEqual({ id: 'n1' });
  });

  it('失败信封：抛 ApiClientError（携带 status/code/detail）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ success: false, error: 'Repo not found', code: 'REPO_NOT_FOUND', detail: 'o/r' }, 404)
      )
    );
    const err = await apiFetch('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    const apiErr = err as ApiClientError;
    expect(apiErr.status).toBe(404);
    expect(apiErr.code).toBe('REPO_NOT_FOUND');
    expect(apiErr.detail).toBe('o/r');
    expect(apiErr.message).toBe('Repo not found');
  });

  it('迁移期兼容：旧路由非信封 JSON 原样返回', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [1, 2], unreadCount: 3 })));
    await expect(apiFetch('/api/legacy')).resolves.toEqual({ items: [1, 2], unreadCount: 3 });
  });

  it('401 默认 redirect：toast 提示并跳转登录页', async () => {
    const assign = vi.fn();
    vi.stubGlobal(
      'window',
      Object.assign(Object.create(null), { location: { assign, pathname: '/' } })
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: false, error: 'Auth' }, 401)));

    await expect(apiFetch('/api/x')).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(toastAdd).toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith('/auth/signin');
  });

  it('401 onUnauthorized=throw：仅抛错，不跳转', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: false, error: 'Auth' }, 401)));
    await expect(apiFetch('/api/x', { onUnauthorized: 'throw' })).rejects.toMatchObject({ status: 401 });
    expect(toastAdd).not.toHaveBeenCalled();
  });

  it('非 JSON 错误响应（网关 HTML）：按 HTTP status 生成 HTTP_ERROR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }))
    );
    await expect(apiFetch('/api/x', { onUnauthorized: 'throw' })).rejects.toMatchObject({
      status: 502,
      code: 'HTTP_ERROR',
    });
  });

  it('429 速率限制错误：旧式 JSON 或文本提取正确文案与 RATE_LIMITED 错误码', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'Too Many Requests' }, 429))
    );
    const err = await apiFetch('/api/rate-limited', { onUnauthorized: 'throw' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    const apiErr = err as ApiClientError;
    expect(apiErr.status).toBe(429);
    expect(apiErr.code).toBe('RATE_LIMITED');
    expect(apiErr.message).toBe('Too Many Requests');
  });

  it('网络异常：抛 NETWORK_ERROR，toastOnError 时弹错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(apiFetch('/api/x', { toastOnError: true })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(toastAdd).toHaveBeenCalled();
  });

  it('api.post：序列化 body 并附加 JSON Content-Type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: 'created' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.post('/api/x', { name: 'demo' })).resolves.toBe('created');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/x');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ name: 'demo' }));
  });

  it('in-flight 去重：并发相同 GET 请求只触发一次底层 fetch', async () => {
    let resolveFirstFetch: (res: Response) => void;
    const pendingPromise = new Promise<Response>((resolve) => {
      resolveFirstFetch = resolve;
    });
    const fetchMock = vi.fn().mockImplementation(() => pendingPromise);
    vi.stubGlobal('fetch', fetchMock);

    // 并发发起 3 次对 /api/user/credits 的 GET 请求
    const p1 = api.get('/api/user/credits');
    const p2 = api.get('/api/user/credits');
    const p3 = api.get('/api/user/credits');

    // 底层 fetch 应该仅被调用 1 次
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 完成网络请求
    resolveFirstFetch!(jsonResponse({ success: true, data: { credits: 100 } }));

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toEqual({ credits: 100 });
    expect(r2).toEqual({ credits: 100 });
    expect(r3).toEqual({ credits: 100 });

    // 请求完成后，Map 应该已清除，后续请求会再次发起
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { credits: 90 } }));
    const p4 = await api.get('/api/user/credits');
    expect(p4).toEqual({ credits: 90 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('skipDedup：指定 skipDedup=true 时绕过在途合并', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ success: true, data: 'ok' })));
    vi.stubGlobal('fetch', fetchMock);

    const [r1, r2] = await Promise.all([
      api.get('/api/fresh', { skipDedup: true }),
      api.get('/api/fresh', { skipDedup: true }),
    ]);

    expect(r1).toBe('ok');
    expect(r2).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('isPublicApiPath（网关公开路由白名单）', () => {
  it('正确放行公开 API 与静态白名单，拦截私有 API', async () => {
    const { isPublicApiPath } = await import('@/lib/public-routes');

    // 核心探针与公开路由
    expect(isPublicApiPath('/api/health')).toBe(true);
    expect(isPublicApiPath('/api/ai/providers')).toBe(true);
    expect(isPublicApiPath('/api/user/credits')).toBe(true);
    expect(isPublicApiPath('/api/docs-content/opengits/demo/overview')).toBe(true);
    expect(isPublicApiPath('/api/assets/opengits/demo/logo.png')).toBe(true);
    expect(isPublicApiPath('/api/auth/session')).toBe(true);
    expect(isPublicApiPath('/api/mcp/message')).toBe(true);
    expect(isPublicApiPath('/api/llms-txt/owner/repo')).toBe(true);
    expect(isPublicApiPath('/api/repos/repo-123/view')).toBe(true);
    expect(isPublicApiPath('/api/repositories/reading-progress/sync')).toBe(true);

    // 私有端点必须被拦截（返回 false，交由 proxy.ts 进行 JWT 校验）
    expect(isPublicApiPath('/api/user/model-providers')).toBe(false);
    expect(isPublicApiPath('/api/user/preferences')).toBe(false);
    expect(isPublicApiPath('/api/notifications')).toBe(false);
    expect(isPublicApiPath('/api/admin/users')).toBe(false);
  });

  it('前缀精确化：兄弟前缀路径不得搭白名单便车', async () => {
    const { isPublicApiPath, isMcpProtocolPath } = await import('@/lib/public-routes');

    // /api/mcp 豁免只认本体与子路径，/api/mcpX 兄弟前缀不豁免
    expect(isMcpProtocolPath('/api/mcp')).toBe(true);
    expect(isMcpProtocolPath('/api/mcp/a/b')).toBe(true);
    expect(isMcpProtocolPath('/api/mcp-x')).toBe(false);
    expect(isPublicApiPath('/api/mcp-x')).toBe(false);

    // 精确匹配条目不得吞掉兄弟路径
    expect(isPublicApiPath('/api/dissect-evil')).toBe(false);
    expect(isPublicApiPath('/api/ai/providers-x')).toBe(false);
    expect(isPublicApiPath('/api/llms-txt-x')).toBe(false);
  });
});
