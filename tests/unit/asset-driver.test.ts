import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSidecarAssetServe, pipeSidecarAssetResponse } from '@/engine/asset-driver';

describe('asset-driver (Go worker-sidecar asset streaming proxy)', () => {
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

  // 🧪 向量 2.15.8.1: 静态资产代理下沉 Go 原生流式直出与 Zero-Buffer 管道
  describe('2.15.8.1 · 静态资产代理下沉 Go 原生流式直出与 Zero-Buffer 管道', () => {
    it('当 sidecar 离线或网络异常时 Fail-Open 优雅降级返回 null', async () => {
      process.env.INTERNAL_API_TOKEN = 'test-token';
      process.env.WORKER_SIDECAR_URL = 'http://127.0.0.1:8082';

      globalThis.fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8082'));

      const result = await executeSidecarAssetServe({
        owner: 'testowner',
        repo: 'testrepo',
        path: 'images/banner.png',
      });

      expect(result).toBeNull();
    });

    it('当未配置 INTERNAL_API_TOKEN 时直接 Fail-Open 返回 null', async () => {
      delete process.env.INTERNAL_API_TOKEN;

      const result = await executeSidecarAssetServe({
        owner: 'testowner',
        repo: 'testrepo',
        path: 'images/banner.png',
      });

      expect(result).toBeNull();
    });

    it('正确拼装 Query 参数、支持 HEAD 请求方法并注入 x-internal-token 与 manual 重定向策略', async () => {
      process.env.INTERNAL_API_TOKEN = 'secret-token-xyz';
      process.env.WORKER_SIDECAR_URL = 'http://localhost:8082';

      const mockResponse = new Response(null, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': '1024',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        },
      });

      const fetchMock = vi.fn().mockResolvedValue(mockResponse);
      globalThis.fetch = fetchMock;

      const res = await executeSidecarAssetServe({
        owner: 'opengits',
        repo: 'docs',
        path: 'assets/logo.png',
        sha: 'abcdef1234567890',
        branch: 'dev',
        method: 'HEAD',
      });

      expect(res).toBe(mockResponse);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsedUrl = new URL(calledUrl);
      expect(parsedUrl.pathname).toBe('/v1/assets/serve');
      expect(parsedUrl.searchParams.get('owner')).toBe('opengits');
      expect(parsedUrl.searchParams.get('repo')).toBe('docs');
      expect(parsedUrl.searchParams.get('path')).toBe('assets/logo.png');
      expect(parsedUrl.searchParams.get('sha')).toBe('abcdef1234567890');
      expect(parsedUrl.searchParams.get('branch')).toBe('dev');

      expect(calledInit.method).toBe('HEAD');
      expect(calledInit.redirect).toBe('manual');
      expect((calledInit.headers as Record<string, string>)['x-internal-token']).toBe('secret-token-xyz');
    });

    it('sidecar 返回 404 Not Found 时原样透传结果对象', async () => {
      process.env.INTERNAL_API_TOKEN = 'secret-token-xyz';

      const notFoundRes = new Response(JSON.stringify({ error: 'asset not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });

      globalThis.fetch = vi.fn().mockResolvedValue(notFoundRes);

      const res = await executeSidecarAssetServe({
        owner: 'opengits',
        repo: 'docs',
        path: 'non-existent.png',
      });

      expect(res).toBe(notFoundRes);
      expect(res?.status).toBe(404);
    });

    it('sidecar 返回 400 Bad Request 时作为确定性校验失败透传（不盲目回退）', async () => {
      process.env.INTERNAL_API_TOKEN = 'secret-token-xyz';

      const badReqRes = new Response(JSON.stringify({ error: 'invalid asset path' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });

      globalThis.fetch = vi.fn().mockResolvedValue(badReqRes);

      const res = await executeSidecarAssetServe({
        owner: 'opengits',
        repo: 'docs',
        path: '../secret.png',
      });

      expect(res).toBe(badReqRes);
      expect(res?.status).toBe(400);
    });

    it('sidecar 返回 500 错误时 Fail-Open 返回 null', async () => {
      process.env.INTERNAL_API_TOKEN = 'secret-token-xyz';

      const errorRes = new Response(JSON.stringify({ error: 'internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });

      globalThis.fetch = vi.fn().mockResolvedValue(errorRes);

      const res = await executeSidecarAssetServe({
        owner: 'opengits',
        repo: 'docs',
        path: 'err.png',
      });

      expect(res).toBeNull();
    });
  });

  // 🧪 向量 2.15.8.2: 资产流式响应 Range 头部（206）与 304 协商缓存透传
  describe('2.15.8.2 · 资产流式响应 Range 头部（206）与 304 协商缓存透传', () => {
    it('向 sidecar 透传 Range、If-Range 与全套条件缓存请求头', async () => {
      process.env.INTERNAL_API_TOKEN = 'test-token';

      const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
      globalThis.fetch = fetchMock;

      const incomingHeaders = new Headers();
      incomingHeaders.set('range', 'bytes=0-1024');
      incomingHeaders.set('if-range', '"etag-v1"');
      incomingHeaders.set('if-modified-since', 'Mon, 14 Sep 2026 00:00:00 GMT');
      incomingHeaders.set('if-none-match', '"etag-abc"');
      incomingHeaders.set('if-match', '"etag-exact"');
      incomingHeaders.set('if-unmodified-since', 'Sun, 13 Sep 2026 00:00:00 GMT');

      await executeSidecarAssetServe({
        owner: 'owner',
        repo: 'repo',
        path: 'video.mp4',
        headers: incomingHeaders,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = calledInit.headers as Record<string, string>;

      expect(headers['range']).toBe('bytes=0-1024');
      expect(headers['if-range']).toBe('"etag-v1"');
      expect(headers['if-modified-since']).toBe('Mon, 14 Sep 2026 00:00:00 GMT');
      expect(headers['if-none-match']).toBe('"etag-abc"');
      expect(headers['if-match']).toBe('"etag-exact"');
      expect(headers['if-unmodified-since']).toBe('Sun, 13 Sep 2026 00:00:00 GMT');
      expect(headers['x-internal-token']).toBe('test-token');
    });

    it('pipeSidecarAssetResponse 正确转发 206 Partial Content 与分块头部', async () => {
      const chunkData = 'part-of-video';
      const sidecarRes = new Response(chunkData, {
        status: 206,
        statusText: 'Partial Content',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': '13',
          'Content-Range': 'bytes 0-12/1000',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'ETag': '"video-etag-1"',
          'Last-Modified': 'Mon, 14 Sep 2026 00:00:00 GMT',
        },
      });

      const clientRes = pipeSidecarAssetResponse(sidecarRes);

      expect(clientRes.status).toBe(206);
      expect(clientRes.headers.get('Content-Type')).toBe('video/mp4');
      expect(clientRes.headers.get('Content-Length')).toBe('13');
      expect(clientRes.headers.get('Content-Range')).toBe('bytes 0-12/1000');
      expect(clientRes.headers.get('Accept-Ranges')).toBe('bytes');
      expect(clientRes.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
      expect(clientRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(clientRes.headers.get('ETag')).toBe('"video-etag-1"');
      expect(clientRes.headers.get('Last-Modified')).toBe('Mon, 14 Sep 2026 00:00:00 GMT');

      const text = await clientRes.text();
      expect(text).toBe(chunkData);
    });

    it('pipeSidecarAssetResponse 正确转发 304 Not Modified 且响应体为 null', async () => {
      const sidecarRes = new Response(null, {
        status: 304,
        statusText: 'Not Modified',
        headers: {
          'ETag': '"cached-etag-123"',
          'Last-Modified': 'Mon, 14 Sep 2026 00:00:00 GMT',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });

      const clientRes = pipeSidecarAssetResponse(sidecarRes);

      expect(clientRes.status).toBe(304);
      expect(clientRes.headers.get('ETag')).toBe('"cached-etag-123"');
      expect(clientRes.headers.get('Last-Modified')).toBe('Mon, 14 Sep 2026 00:00:00 GMT');
      expect(clientRes.body).toBeNull();
    });

    it('pipeSidecarAssetResponse 正确转发 302 Found CDN 重定向且响应体为 null 绝不挂起流', async () => {
      const sidecarRes = new Response(null, {
        status: 302,
        statusText: 'Found',
        headers: {
          'Location': 'https://cdn.example.com/assets/logo.png',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });

      const clientRes = pipeSidecarAssetResponse(sidecarRes);

      expect(clientRes.status).toBe(302);
      expect(clientRes.headers.get('Location')).toBe('https://cdn.example.com/assets/logo.png');
      expect(clientRes.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
      expect(clientRes.body).toBeNull();
    });

    it('pipeSidecarAssetResponse 正确转发 X-OGIS 头部与合并 extraHeaders', async () => {
      const sidecarRes = new Response('binary-stream-chunk', {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '19',
          'ETag': '"git-sha-12345"',
          'X-OGIS-Version': '1',
          'X-OGIS-GitSha': 'git-sha-12345',
        },
      });

      const clientRes = pipeSidecarAssetResponse(sidecarRes, {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Custom-Header': 'custom-value',
      });

      expect(clientRes.status).toBe(200);
      expect(clientRes.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(clientRes.headers.get('ETag')).toBe('"git-sha-12345"');
      expect(clientRes.headers.get('X-OGIS-Version')).toBe('1');
      expect(clientRes.headers.get('X-OGIS-GitSha')).toBe('git-sha-12345');
      expect(clientRes.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
      expect(clientRes.headers.get('X-Custom-Header')).toBe('custom-value');
      expect(await clientRes.text()).toBe('binary-stream-chunk');
    });
  });
});
