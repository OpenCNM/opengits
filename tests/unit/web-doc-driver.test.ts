import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSidecarWebDocDiff } from '@/engine/web-doc-driver';

/**
 * web-doc driver（2026-11-03 收口版）：抓取执行（快道/Firecrawl/图片转存/robots）
 * 已全量下沉 Go internal/webdoc 进程内承载，TS 侧仅剩 Sitemap 差分代理——
 * 差分契约由冻结夹具 web-doc-*.golden.json 在 Go 端锁定，
 * 本文件仅覆盖 Fail-Closed 语义与透传。
 */

describe('web-doc-driver (Fail-Closed single implementation)', () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env.INTERNAL_API_TOKEN;
    delete process.env.WORKER_SIDECAR_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sidecar 离线时差分代理显式抛 SidecarError（无本地回退）', async () => {
    await expect(executeSidecarWebDocDiff('https://example.com')).rejects.toThrow(
      /sidecar unreachable|not configured/
    );
  });

  it('sidecar 在线时透传 Sitemap 差分结果', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
    const diff = {
      hasChanges: true,
      etag: 'W/"abc"',
      sitemapLastModMap: {},
      totalPages: 10,
      pagesToAdd: ['/new'],
      pagesToUpdate: [],
      pagesToRemove: ['/old'],
      totalChanged: 2,
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => diff,
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const got = await executeSidecarWebDocDiff('https://example.com', { etag: 'W/"old"' });
    expect(got.hasChanges).toBe(true);
    expect(got.pagesToAdd).toEqual(['/new']);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/v1/web-doc/diff');
    expect(init.headers).toMatchObject({ 'x-internal-token': 'test-internal-token' });
  });

  it('畸形载荷显式抛错而非回退', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ foo: 1 }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(executeSidecarWebDocDiff('https://example.com')).rejects.toThrow(
      /malformed diff payload/
    );
  });
});
