import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSidecarCandidateSet, executeSidecarUpdateApply } from '@/engine/update-candidate-driver';

/**
 * update-candidate driver（2026-09-11 收刀版）：本地 localBuildUpdateCandidateSet
 * 已物理删除（含其 Prisma 自查段——Go pgx store 同位承载），契约由冻结夹具
 * update-candidate.golden.json 在 Go 端锁定——本文件仅覆盖 Fail-Closed 语义与透传。
 */

const baseParams = {
  owner: 'owner',
  repo: 'repo',
  branch: 'main',
  fromSha: 'a'.repeat(40),
  toSha: 'b'.repeat(40),
  repositoryId: 'repo-id-1',
  docOwnerId: null as string | null,
};

describe('update-candidate-driver (Fail-Closed single implementation)', () => {
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

  it('sidecar 离线时显式抛 SidecarError（无本地回退）', async () => {
    await expect(executeSidecarCandidateSet(baseParams)).rejects.toThrow(
      /sidecar unreachable|not configured/
    );
  });

  // 🧪 [5.2.1.2 · HIGH] 增量更新候选集与差异比对一站式下沉至 Go worker-sidecar (零跨进程 RPC 乒乓与 V8 集合抖动)
  // AntiPattern: Node.js 多次往返 RPC 打包万级节点且在主线程维护海量 Set/Map 诱发 GC 停顿
  // DefenseAssertion: Go 侧纯内存完成重聚类、图谱语义漂移与章节反查映射，单次交互一站式产出完整候选集
  it('5.2.1.2 sidecar 在线时透传候选集并携带鉴权头', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
    const candidateSet = {
      chapters: [{ path: 'docs/a.md', action: 'update', affectedFiles: [{ path: 'docs/a.md', change: 'modified' }] }],
      unmatchedFiles: [],
      structuralAdds: [],
      structuralRemoves: [],
      diffStats: { added: 0, modified: 1, removed: 0 },
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => candidateSet,
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const got = await executeSidecarCandidateSet(baseParams);
    expect(got.chapters).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/v1/update/candidate-set');
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

    await expect(executeSidecarCandidateSet(baseParams)).rejects.toThrow(
      /malformed candidate set payload/
    );
  });

  describe('executeSidecarUpdateApply', () => {
    const applyParams = {
      repositoryId: 'repo-id-1',
      userId: 'user-1',
      docOwnerId: null,
      fromSha: 'a'.repeat(40),
      toSha: 'b'.repeat(40),
      plan: {
        chapters: [{ path: 'docs/a.md', action: 'update' as const }],
        summary: 'summary',
      },
      candidateSet: {
        chapters: [{ path: 'docs/a.md', change: 'content' as const, affectedFiles: [] }],
        unmatchedFiles: [],
        structuralAdds: [],
        structuralRemoves: [],
        diffStats: { added: 0, modified: 1, removed: 0, renamed: 0 },
        hasOldArchive: false,
      },
    };

    it('sidecar 离线时显式抛 SidecarError', async () => {
      await expect(executeSidecarUpdateApply(applyParams)).rejects.toThrow(
        /sidecar unreachable|not configured/
      );
    });

    it('sidecar 在线时透传 apply 请求并返回 ApplyUpdateResult', async () => {
      process.env.INTERNAL_API_TOKEN = 'test-internal-token';
      const applyResult = {
        updatedDocs: 1,
        removedDocs: 0,
        addedDocs: 0,
        renamedDocs: 0,
        coercedActions: 0,
        navTreePatched: true,
        gitShaAdvanced: true,
      };
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: applyResult }),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const got = await executeSidecarUpdateApply(applyParams);
      expect(got.updatedDocs).toBe(1);
      expect(got.navTreePatched).toBe(true);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toContain('/v1/update/apply');
      expect(init.headers).toMatchObject({ 'x-internal-token': 'test-internal-token' });
    });

    it('畸形响应体显式抛错', async () => {
      process.env.INTERNAL_API_TOKEN = 'test-internal-token';
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(executeSidecarUpdateApply(applyParams)).rejects.toThrow(
        /malformed response payload/
      );
    });
  });
});
