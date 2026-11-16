import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSidecarArchiveTree, executeSidecarSniff } from '@/engine/sniffer-driver';

/**
 * sniffer driver（2026-09-11 收刀版）：本地 sniffRepo/localTreeFromArchive 双轨
 * 已物理删除（仓库画像契约由 Go /v1/archive/sniff 单实现，冻结夹具
 * ingest-profile.golden.json 锁定规则语义）——本文件仅覆盖 Fail-Closed 语义与透传。
 */

describe('sniffer-driver (Fail-Closed single implementation)', () => {
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

  it('1.16.1.4 sidecar 离线时两函数显式抛 SidecarError（Fail-Closed 契约，无本地回退）', async () => {
    await expect(executeSidecarArchiveTree('o', 'r', 'a'.repeat(40))).rejects.toThrow(
      /sidecar unreachable|not configured/
    );
    await expect(executeSidecarSniff({ nodes: [] })).rejects.toThrow(
      /sidecar unreachable|not configured/
    );
  });

  it('缺省入参显式报错（owner/repo/sha 或 nodes 至少其一）', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
    await expect(executeSidecarSniff({} as never)).rejects.toThrow(/至少提供其一/);
  });

  it('1.16.1.3 sidecar 在线时透传归档树与画像（Zero-Tree 嗅探与目录树提取下沉）', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
    const treeRes = { ok: true, nodes: [{ path: 'README.md', type: 'blob', size: 100 }] };
    const profileRes = {
      ok: true,
      profile: {
        tier: 'docs',
        textRoot: 'docs/',
        languageHubs: {},
        globalAssets: { pdfs: [], translations: [], buildScripts: [], misc: [] },
        labRoots: [],
        translationRoots: [],
        excludeFromNav: [],
      },
      scale: { scale: 'medium', confidence: 0.9 },
    };
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/v1/archive/tree')) {
        return { ok: true, status: 200, json: async () => treeRes };
      }
      return { ok: true, status: 200, json: async () => profileRes };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const nodes = await executeSidecarArchiveTree('o', 'r', 'a'.repeat(40));
    expect(nodes[0].path).toBe('README.md');

    const { profile } = await executeSidecarSniff({ nodes: [] });
    expect(profile.tier).toBe('docs');
    const [url, init] = (fetchMock.mock.calls[1] ?? fetchMock.mock.calls[0]) as [string, RequestInit];
    expect(String(url)).toContain('/v1/archive/sniff');
    expect(init.headers).toMatchObject({ 'x-internal-token': 'test-internal-token' });
  });
});
