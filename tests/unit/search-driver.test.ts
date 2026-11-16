import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  executeSidecarSearch,
  executeSidecarUnifiedSearch,
  buildRepoBinaryIndexViaSidecar,
} from '@/engine/search-driver';

/**
 * search driver（2026-09-11 收刀版 + 2026-09-12 OGIS Go 下沉）：
 * 检索契约由 Go /v1/search/chunks 承载，索引构建由 /v1/search/index/build 承载。
 * 本文件覆盖 Fail-Closed 契约与透传验证。
 */

describe('search-driver (Fail-Closed single implementation)', () => {
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

  it('空查询短路返回空数组（不触达 sidecar）', async () => {
    expect(await executeSidecarSearch({ query: '  ' })).toEqual([]);
  });

  it('sidecar 离线/500 时显式抛 SidecarError（无本地回退）', async () => {
    await expect(executeSidecarSearch({ query: 'hook' })).rejects.toThrow(
      /sidecar unreachable|not configured/
    );
  });

  it('sidecar 在线时透传轻量命中并携带鉴权头', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
    const hits = [
      {
        chunkId: 'c1',
        docId: 'd1',
        title: 'Guide',
        path: 'docs/guide.md',
        heading: null,
        headingPath: null,
        snippet: 'use the hook',
        similarity: 0.9,
      },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hits }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const got = await executeSidecarSearch({ query: 'hook', repositoryId: 'r1' });
    expect(got).toEqual(hits);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/v1/search/chunks');
    expect(init.headers).toMatchObject({ 'x-internal-token': 'test-internal-token' });
  });

  describe('buildRepoBinaryIndexViaSidecar', () => {
    it('空 repositoryId 短路抛错（不触达 sidecar）', async () => {
      await expect(buildRepoBinaryIndexViaSidecar('')).rejects.toThrow(/repositoryId is required/);
      await expect(buildRepoBinaryIndexViaSidecar('   ')).rejects.toThrow(/repositoryId is required/);
    });

    it('sidecar 未配置或离线时抛 SidecarError', async () => {
      await expect(buildRepoBinaryIndexViaSidecar('repo-1')).rejects.toThrow(
        /INTERNAL_API_TOKEN is not configured|not configured/
      );
    });

    it('sidecar 返回 500 时显式抛 SidecarError', async () => {
      process.env.INTERNAL_API_TOKEN = 'test-internal-token';
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'build repo failed' }),
        text: async () => 'build repo failed',
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(buildRepoBinaryIndexViaSidecar('repo-1')).rejects.toThrow(/HTTP 500/);
    });

    it('sidecar 在线时正确传递 repositoryId 与鉴权头并返回 built 状态', async () => {
      process.env.INTERNAL_API_TOKEN = 'test-internal-token';
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, built: true }),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const res = await buildRepoBinaryIndexViaSidecar('repo-xyz');
      expect(res).toEqual({ built: true });

      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain('/v1/search/index/build');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({ 'x-internal-token': 'test-internal-token' });
      expect(JSON.parse(init.body as string)).toEqual({ repositoryId: 'repo-xyz' });
    });
  });

  describe('executeSidecarUnifiedSearch', () => {
    it('空查询短路返回空数组（不触达 sidecar）', async () => {
      expect(await executeSidecarUnifiedSearch({ query: '   ', rawQuery: '' })).toEqual([]);
    });

    it('sidecar 离线时显式抛 SidecarError（Fail-Closed）', async () => {
      await expect(executeSidecarUnifiedSearch({ query: 'zustand' })).rejects.toThrow(
        /INTERNAL_API_TOKEN is not configured|not configured/
      );
    });

    it('sidecar 在线时正确透传统一检索参数与鉴权头', async () => {
      process.env.INTERNAL_API_TOKEN = 'test-internal-token';
      const hits = [
        {
          id: 'repo-1',
          type: 'repository_exists' as const,
          isIngested: true,
          title: 'facebook/react',
          description: 'React docs',
          url: '/docs/facebook/react',
          score: 1000,
        },
      ];
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, hits }),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const res = await executeSidecarUnifiedSearch({
        query: 'react',
        rawQuery: 'react',
        owner: 'facebook',
        repo: 'react',
        exactOwner: 'facebook',
        exactRepo: 'react',
        limit: 15,
      });

      expect(res).toEqual(hits);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain('/v1/search/unified');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({ 'x-internal-token': 'test-internal-token' });
      expect(JSON.parse(init.body as string)).toMatchObject({
        query: 'react',
        rawQuery: 'react',
        owner: 'facebook',
        repo: 'react',
        exactOwner: 'facebook',
        exactRepo: 'react',
        limit: 15,
      });
    });
  });
});


