import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockFindFirst = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
    },
  },
}));

const mockGetSessionHelper = vi.fn();
vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: () => mockGetSessionHelper(),
}));

const mockVerifyRepoAccessDirect = vi.fn();
vi.mock('@/lib/auth-utils', () => ({
  verifyRepoAccessDirect: (...args: unknown[]) => mockVerifyRepoAccessDirect(...args),
}));

const mockCachedDefaultBranchRepository = vi.fn();
vi.mock('@/lib/mcp/repo-resolve-cache', () => ({
  cachedDefaultBranchRepository: (...args: unknown[]) => mockCachedDefaultBranchRepository(...args),
}));

const mockCheckRateLimit = vi.fn();
const mockClientIpFromRequest = vi.fn();
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  clientIpFromRequest: (...args: unknown[]) => mockClientIpFromRequest(...args),
}));

const mockExecuteSidecarAssetServe = vi.fn();
vi.mock('@/engine/asset-driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/asset-driver')>();
  return {
    ...actual,
    executeSidecarAssetServe: (...args: unknown[]) => mockExecuteSidecarAssetServe(...args),
  };
});

const mockBuildRepoBinaryIndexViaSidecar = vi.fn();
vi.mock('@/engine/search-driver', () => ({
  buildRepoBinaryIndexViaSidecar: (...args: unknown[]) => mockBuildRepoBinaryIndexViaSidecar(...args),
}));

const mockGetOrGenerateRepoBinaryIndex = vi.fn();
vi.mock('@/lib/search/binary-index-service', () => ({
  getOrGenerateRepoBinaryIndex: (...args: unknown[]) => mockGetOrGenerateRepoBinaryIndex(...args),
}));

import { GET } from '@/app/api/search/index/[owner]/[repo]/route';

describe('/api/search/index/[owner]/[repo] route', () => {
  const defaultRepo = {
    id: 'repo-uuid-1',
    owner: 'testowner',
    repo: 'testrepo',
    isPublic: true,
    branch: 'main',
    gitSha: 'sha-abcdef123456',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCachedDefaultBranchRepository.mockResolvedValue(null);
    mockFindFirst.mockResolvedValue(defaultRepo);
    mockCheckRateLimit.mockResolvedValue(true);
    mockClientIpFromRequest.mockReturnValue('127.0.0.1');
    mockGetSessionHelper.mockResolvedValue(null);
    mockVerifyRepoAccessDirect.mockResolvedValue(true);
    mockExecuteSidecarAssetServe.mockResolvedValue(null);
    mockBuildRepoBinaryIndexViaSidecar.mockResolvedValue({ built: true });
    mockGetOrGenerateRepoBinaryIndex.mockResolvedValue({
      buffer: Buffer.from('mock-ogis-index-data'),
      gitSha: 'sha-abcdef123456',
    });
  });

  // ── 🧪 9.4.2.4 · 二进制索引流式直出零堆内存分配与 304 协商缓存 ──
  describe('🧪 [9.4.2.4] 二进制索引流式直出零堆内存分配与 304 协商缓存', () => {
    it('公开仓走 Fast-Path 快速通道，彻底跳过 getSessionHelper() JWE 解密', async () => {
      mockCachedDefaultBranchRepository.mockResolvedValue({
        ...defaultRepo,
        isPublic: true,
      });

      const sidecarStream = new Response('binary-index-stream', {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '19',
          'ETag': '"sha-abcdef123456"',
          'X-OGIS-Version': '1',
          'X-OGIS-GitSha': 'sha-abcdef123456',
        },
      });
      mockExecuteSidecarAssetServe.mockResolvedValue(sidecarStream);

      const req = new NextRequest('http://localhost:3000/api/search/index/testowner/testrepo');
      const res = await GET(req, {
        params: Promise.resolve({ owner: 'testowner', repo: 'testrepo' }),
      });

      expect(res.status).toBe(200);
      expect(mockGetSessionHelper).not.toHaveBeenCalled();
      expect(mockExecuteSidecarAssetServe).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'testowner',
          repo: 'testrepo',
          path: 'search-index-sha-abcdef123456.bin',
          sha: 'sha-abcdef123456',
        }),
      );
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('ETag')).toBe('"sha-abcdef123456"');
      expect(res.headers.get('X-OGIS-Version')).toBe('1');
      expect(res.headers.get('X-OGIS-GitSha')).toBe('sha-abcdef123456');
    });

    it('私有仓惰性求值 Session 并鉴权，未授权用户返回 403 Forbidden', async () => {
      mockCachedDefaultBranchRepository.mockResolvedValue({
        ...defaultRepo,
        isPublic: false,
      });
      mockGetSessionHelper.mockResolvedValue({ user: { id: 'user-unauthorized' } });
      mockVerifyRepoAccessDirect.mockResolvedValue(false);

      const req = new NextRequest('http://localhost:3000/api/search/index/testowner/testrepo');
      const res = await GET(req, {
        params: Promise.resolve({ owner: 'testowner', repo: 'testrepo' }),
      });

      expect(res.status).toBe(403);
      expect(mockGetSessionHelper).toHaveBeenCalledTimes(1);
      expect(mockVerifyRepoAccessDirect).toHaveBeenCalledWith(
        expect.objectContaining({ isPublic: false }),
        'user-unauthorized',
      );
      const json = await res.json();
      expect(json.error).toMatch(/Forbidden/i);
    });

    it('私有仓授权用户通过鉴权，响应头返回 private 缓存控制', async () => {
      mockCachedDefaultBranchRepository.mockResolvedValue({
        ...defaultRepo,
        isPublic: false,
      });
      mockGetSessionHelper.mockResolvedValue({ user: { id: 'user-authorized' } });
      mockVerifyRepoAccessDirect.mockResolvedValue(true);

      const sidecarStream = new Response('private-binary-index', {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'ETag': '"sha-abcdef123456"',
          'X-OGIS-Version': '1',
          'X-OGIS-GitSha': 'sha-abcdef123456',
        },
      });
      mockExecuteSidecarAssetServe.mockResolvedValue(sidecarStream);

      const req = new NextRequest('http://localhost:3000/api/search/index/testowner/testrepo');
      const res = await GET(req, {
        params: Promise.resolve({ owner: 'testowner', repo: 'testrepo' }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('private, max-age=3600');
      expect(res.headers.get('ETag')).toBe('"sha-abcdef123456"');
    });

    it('公开仓与私有仓超出访问限流配额时返回 429 Too Many Requests', async () => {
      mockCheckRateLimit.mockResolvedValue(false);

      // 公开仓限流
      const reqPublic = new NextRequest('http://localhost:3000/api/search/index/testowner/testrepo');
      const resPublic = await GET(reqPublic, {
        params: Promise.resolve({ owner: 'testowner', repo: 'testrepo' }),
      });
      expect(resPublic.status).toBe(429);
      expect(await resPublic.text()).toBe('Too Many Requests');

      // 私有仓限流
      mockCachedDefaultBranchRepository.mockResolvedValue({
        ...defaultRepo,
        isPublic: false,
      });
      mockGetSessionHelper.mockResolvedValue({ user: { id: 'user-rate-limited' } });

      const reqPrivate = new NextRequest('http://localhost:3000/api/search/index/testowner/testrepo');
      const resPrivate = await GET(reqPrivate, {
        params: Promise.resolve({ owner: 'testowner', repo: 'testrepo' }),
      });
      expect(resPrivate.status).toBe(429);
      expect(await resPrivate.text()).toBe('Too Many Requests');
    });

    it('If-None-Match ETag 匹配时直接响应 304 Not Modified，响应体为 null 且包含完备缓存头', async () => {
      const req = new NextRequest('http://localhost:3000/api/search/index/testowner/testrepo', {
        headers: { 'if-none-match': '"sha-abcdef123456"' },
      });
      const res = await GET(req, {
        params: Promise.resolve({ owner: 'testowner', repo: 'testrepo' }),
      });

      expect(res.status).toBe(304);
      expect(res.body).toBeNull();
      expect(res.headers.get('ETag')).toBe('"sha-abcdef123456"');
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('X-OGIS-Version')).toBe('1');
      expect(res.headers.get('X-OGIS-GitSha')).toBe('sha-abcdef123456');
      expect(mockExecuteSidecarAssetServe).not.toHaveBeenCalled();
      expect(mockGetOrGenerateRepoBinaryIndex).not.toHaveBeenCalled();
    });

    it('If-None-Match 携带弱校验前缀 W/ 时仍正确协商 304 Not Modified', async () => {
      const req = new NextRequest('http://localhost:3000/api/search/index/testowner/testrepo', {
        headers: { 'if-none-match': 'W/"sha-abcdef123456"' },
      });
      const res = await GET(req, {
        params: Promise.resolve({ owner: 'testowner', repo: 'testrepo' }),
      });

      expect(res.status).toBe(304);
      expect(res.body).toBeNull();
      expect(res.headers.get('ETag')).toBe('"sha-abcdef123456"');
      expect(mockExecuteSidecarAssetServe).not.toHaveBeenCalled();
    });

    it('Sidecar 命中时通过 executeSidecarAssetServe + pipeSidecarAssetResponse 零堆内存流式直出', async () => {
      const sidecarStream = new Response('streamed-content-bytes', {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '22',
          'ETag': '"sha-abcdef123456"',
          'X-OGIS-Version': '1',
          'X-OGIS-GitSha': 'sha-abcdef123456',
        },
      });
      mockExecuteSidecarAssetServe.mockResolvedValue(sidecarStream);

      const req = new NextRequest('http://localhost:3000/api/search/index/testowner/testrepo');
      const res = await GET(req, {
        params: Promise.resolve({ owner: 'testowner', repo: 'testrepo' }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(res.headers.get('X-OGIS-Version')).toBe('1');
      expect(res.headers.get('X-OGIS-GitSha')).toBe('sha-abcdef123456');
      expect(res.headers.get('ETag')).toBe('"sha-abcdef123456"');
      expect(await res.text()).toBe('streamed-content-bytes');
      // Node 侧生成器完全未被触达
      expect(mockGetOrGenerateRepoBinaryIndex).not.toHaveBeenCalled();
    });

    it('Sidecar 返回 302 CDN 重定向时透传 Location 与缓存头部', async () => {
      const sidecarRedirect = new Response(null, {
        status: 302,
        headers: {
          Location: 'https://cdn.opengits.org/storage/assets/testowner/testrepo/search-index-sha-abcdef123456.bin',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
      mockExecuteSidecarAssetServe.mockResolvedValue(sidecarRedirect);

      const req = new NextRequest('http://localhost:3000/api/search/index/testowner/testrepo');
      const res = await GET(req, {
        params: Promise.resolve({ owner: 'testowner', repo: 'testrepo' }),
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe(
        'https://cdn.opengits.org/storage/assets/testowner/testrepo/search-index-sha-abcdef123456.bin',
      );
      expect(mockGetOrGenerateRepoBinaryIndex).not.toHaveBeenCalled();
    });

    it('Sidecar 支持 HTTP 206 Partial Content 范围分片直出', async () => {
      const sidecarPartial = new Response('partial-bytes', {
        status: 206,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': 'bytes 0-12/100',
          'Accept-Ranges': 'bytes',
          ETag: '"sha-abcdef123456"',
        },
      });
      mockExecuteSidecarAssetServe.mockResolvedValue(sidecarPartial);

      const req = new NextRequest('http://localhost:3000/api/search/index/testowner/testrepo', {
        headers: { range: 'bytes=0-12' },
      });
      const res = await GET(req, {
        params: Promise.resolve({ owner: 'testowner', repo: 'testrepo' }),
      });

      expect(res.status).toBe(206);
      expect(res.headers.get('Content-Range')).toBe('bytes 0-12/100');
      expect(res.headers.get('Accept-Ranges')).toBe('bytes');
      expect(await res.text()).toBe('partial-bytes');
      expect(mockGetOrGenerateRepoBinaryIndex).not.toHaveBeenCalled();
    });

    it('Sidecar 首次 404 (索引缺失) 触发 JIT buildRepoBinaryIndexViaSidecar 并重试流式直出', async () => {
      const notFoundRes = new Response(null, { status: 404 });
      const successRes = new Response('jit-rebuilt-stream', {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'ETag': '"sha-abcdef123456"',
          'X-OGIS-Version': '1',
          'X-OGIS-GitSha': 'sha-abcdef123456',
        },
      });

      // 首次 404，重试 200
      mockExecuteSidecarAssetServe
        .mockResolvedValueOnce(notFoundRes)
        .mockResolvedValueOnce(successRes);
      mockBuildRepoBinaryIndexViaSidecar.mockResolvedValue({ built: true });

      const req = new NextRequest('http://localhost:3000/api/search/index/testowner/testrepo');
      const res = await GET(req, {
        params: Promise.resolve({ owner: 'testowner', repo: 'testrepo' }),
      });

      expect(res.status).toBe(200);
      expect(mockExecuteSidecarAssetServe).toHaveBeenCalledTimes(2);
      expect(mockBuildRepoBinaryIndexViaSidecar).toHaveBeenCalledWith('repo-uuid-1');
      expect(await res.text()).toBe('jit-rebuilt-stream');
      expect(mockGetOrGenerateRepoBinaryIndex).not.toHaveBeenCalled();
    });

    it('Sidecar JIT 构建失败时 Fail-Open 降级至 Node 兜底生成', async () => {
      const notFoundRes = new Response(null, { status: 404 });
      mockExecuteSidecarAssetServe.mockResolvedValue(notFoundRes);
      mockBuildRepoBinaryIndexViaSidecar.mockRejectedValue(new Error('sidecar out of memory'));
      mockGetOrGenerateRepoBinaryIndex.mockResolvedValue({
        buffer: Buffer.from('node-jit-fallback'),
        gitSha: 'sha-abcdef123456',
      });

      const req = new NextRequest('http://localhost:3000/api/search/index/testowner/testrepo');
      const res = await GET(req, {
        params: Promise.resolve({ owner: 'testowner', repo: 'testrepo' }),
      });

      expect(res.status).toBe(200);
      expect(mockGetOrGenerateRepoBinaryIndex).toHaveBeenCalledTimes(1);
      expect(await res.text()).toBe('node-jit-fallback');
    });

    it('Sidecar 离线或不可达时 Fail-Open 降级至 Node getOrGenerateRepoBinaryIndex 兜底生成', async () => {
      mockExecuteSidecarAssetServe.mockResolvedValue(null);
      mockGetOrGenerateRepoBinaryIndex.mockResolvedValue({
        buffer: Buffer.from('node-fallback-binary-index'),
        gitSha: 'sha-abcdef123456',
      });

      const req = new NextRequest('http://localhost:3000/api/search/index/testowner/testrepo');
      const res = await GET(req, {
        params: Promise.resolve({ owner: 'testowner', repo: 'testrepo' }),
      });

      expect(res.status).toBe(200);
      expect(mockGetOrGenerateRepoBinaryIndex).toHaveBeenCalledWith(
        'testowner',
        'testrepo',
        'sha-abcdef123456',
      );
      expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(res.headers.get('X-OGIS-Version')).toBe('1');
      expect(res.headers.get('X-OGIS-GitSha')).toBe('sha-abcdef123456');
      expect(res.headers.get('ETag')).toBe('"sha-abcdef123456"');
      expect(await res.text()).toBe('node-fallback-binary-index');
    });

    it('当 Sidecar 与 Node 兜底均无法生成索引时返回 500 Internal Server Error', async () => {
      mockExecuteSidecarAssetServe.mockResolvedValue(null);
      mockGetOrGenerateRepoBinaryIndex.mockResolvedValue(null);

      const req = new NextRequest('http://localhost:3000/api/search/index/testowner/testrepo');
      const res = await GET(req, {
        params: Promise.resolve({ owner: 'testowner', repo: 'testrepo' }),
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe('Failed to generate search index');
    });

    it('仓库不存在时返回 404 Not Found', async () => {
      mockCachedDefaultBranchRepository.mockResolvedValue(null);
      mockFindFirst.mockResolvedValue(null);

      const req = new NextRequest('http://localhost:3000/api/search/index/nonexistent/repo');
      const res = await GET(req, {
        params: Promise.resolve({ owner: 'nonexistent', repo: 'repo' }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe('Repository not found');
    });
  });

  // ── 🧪 9.4.3.3 · 增量更新与版本置换生命周期索引刷新与缓存失效联动 ──
  describe('🧪 [9.4.3.3] 增量更新与版本置换生命周期索引刷新与缓存失效联动', () => {
    it('验证 Sidecar JIT 构建契约调用正确传递仓库 ID 与执行参数', async () => {
      mockExecuteSidecarAssetServe.mockResolvedValueOnce(new Response(null, { status: 404 }));
      mockExecuteSidecarAssetServe.mockResolvedValueOnce(
        new Response('fresh-index', {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'ETag': '"sha-abcdef123456"',
          },
        }),
      );

      const req = new NextRequest('http://localhost:3000/api/search/index/testowner/testrepo');
      await GET(req, {
        params: Promise.resolve({ owner: 'testowner', repo: 'testrepo' }),
      });

      expect(mockBuildRepoBinaryIndexViaSidecar).toHaveBeenCalledTimes(1);
      expect(mockBuildRepoBinaryIndexViaSidecar).toHaveBeenCalledWith('repo-uuid-1');
    });
  });
});
