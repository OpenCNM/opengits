import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const repoFindUniqueMock = vi.fn();
const repoFindFirstMock = vi.fn();
const queryRawMock = vi.fn();
const putAssetMock = vi.fn();
const getAssetMock = vi.fn();
const buildRepoBinaryIndexViaSidecarMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findUnique: (...args: unknown[]) => repoFindUniqueMock(...args),
      findFirst: (...args: unknown[]) => repoFindFirstMock(...args),
    },
    $queryRaw: (...args: unknown[]) => queryRawMock(...args),
  },
}));

vi.mock('@/lib/storage/assets-store', () => ({
  putAsset: (...args: unknown[]) => putAssetMock(...args),
  getAsset: (...args: unknown[]) => getAssetMock(...args),
  assetExists: vi.fn(),
}));

vi.mock('@/engine/search-driver', () => ({
  buildRepoBinaryIndexViaSidecar: (...args: unknown[]) =>
    buildRepoBinaryIndexViaSidecarMock(...args),
}));

function fakeRepo(id: string, owner = 'o', repo = 'r', gitSha: string | null = 'abc123') {
  return { id, owner, repo, gitSha };
}

function fakeChunkRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    chunkId: `chunk-${i}`,
    heading: `heading-${i}`,
    headingPath: `h-${i}`,
    content: `content ${i} 关于线性内存的说明`,
    title: `Title ${i}`,
    path: `docs/p${i}.md`,
    order: i,
  }));
}

describe('Unit 9.6 二进制搜索索引构建、去抖与 JIT 单飞委托', () => {
  // 🧪 [9.6.1.1] 跨语言 golden 与二进制布局由 tests/unit/binary-index-packer.test.ts 与 Go ogis_packer_test.go 双端锁定
  // 🧪 [9.6.1.2] 分词器中英文/驼峰与 CJK 双字切分由 binary-index-tokenizer.ts 与 Go ogis_tokenizer_test.go 锁定

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    delete process.env.SEARCH_INDEX_GO_BUILDER;
    repoFindUniqueMock.mockImplementation(async (_args: { where: { id: string } }) =>
      fakeRepo(_args.where.id)
    );
    repoFindFirstMock.mockResolvedValue(fakeRepo('repo-1'));
    queryRawMock.mockResolvedValue(fakeChunkRows(3));
    putAssetMock.mockResolvedValue(undefined);
    getAssetMock.mockResolvedValue(null);
    buildRepoBinaryIndexViaSidecarMock.mockResolvedValue({ built: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.SEARCH_INDEX_GO_BUILDER;
  });

  describe('9.6.2 · 写权收敛与批量去抖', () => {
    it('🧪 [9.6.2.1] 默认状态（builder=go）下 scheduleRepoBinaryIndexRefresh 直接 no-op（写权归 Go sidecar）', async () => {
      vi.resetModules();
      const { scheduleRepoBinaryIndexRefresh, __pendingIndexRebuildsForTests } = await import(
        '@/lib/search/binary-index-service'
      );

      scheduleRepoBinaryIndexRefresh('repo-1');
      await vi.advanceTimersByTimeAsync(10_000 + 100);

      expect(__pendingIndexRebuildsForTests()).toEqual([]);
      expect(queryRawMock).not.toHaveBeenCalled();
      expect(putAssetMock).not.toHaveBeenCalled();
      vi.resetModules();
    });

    it('🧪 [9.4.3.1] [9.6.2.1] SEARCH_INDEX_GO_BUILDER=0 时回退本地 Node 调度，同仓连续多次 schedule 只在去抖窗口末尾重建一次', async () => {
      process.env.SEARCH_INDEX_GO_BUILDER = '0';
      vi.resetModules();
      const { scheduleRepoBinaryIndexRefresh } = await import('@/lib/search/binary-index-service');

      scheduleRepoBinaryIndexRefresh('repo-1');
      scheduleRepoBinaryIndexRefresh('repo-1');
      scheduleRepoBinaryIndexRefresh('repo-1');

      // 窗口内不触发
      expect(putAssetMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000 + 100);

      expect(queryRawMock).toHaveBeenCalledTimes(1);
      expect(putAssetMock).toHaveBeenCalledTimes(1);
      vi.resetModules();
    });

    it('🧪 [9.6.2.2] Node 降级模式下不同仓的重建互不去抖合并', async () => {
      process.env.SEARCH_INDEX_GO_BUILDER = '0';
      vi.resetModules();
      const { scheduleRepoBinaryIndexRefresh } = await import('@/lib/search/binary-index-service');

      scheduleRepoBinaryIndexRefresh('repo-1');
      scheduleRepoBinaryIndexRefresh('repo-2');

      await vi.advanceTimersByTimeAsync(10_000 + 100);

      expect(putAssetMock).toHaveBeenCalledTimes(2);
      vi.resetModules();
    });
  });

  describe('9.6.3 · 数据面可见性与对象键约定', () => {
    it('🧪 [9.6.3.1] chunk 查询走双归属 OR-JOIN（停写模式内容层 chunk 仍可见）', async () => {
      const { generateRepoBinaryIndex } = await import('@/lib/search/binary-index-service');
      await generateRepoBinaryIndex('repo-1');

      expect(queryRawMock).toHaveBeenCalledTimes(1);
      // Prisma $queryRaw 的 SQL 模板串必须含双归属 JOIN 与内容层分支
      const sql = String(queryRawMock.mock.calls[0][0]?.sql ?? queryRawMock.mock.calls[0][0] ?? '');
      expect(sql).toContain('"contentId" IS NOT NULL AND d."contentId" = ch."contentId"');
      expect(sql).toContain('"documentId" IS NOT NULL AND d."id" = ch."documentId"');
      expect(putAssetMock).toHaveBeenCalledTimes(1);
    });

    it('🧪 [9.6.3.2] 对象键符合 assets/{owner}/{repo}/search-index-{sha||head}.bin 规范', async () => {
      vi.useRealTimers();
      const { getOrGenerateRepoBinaryIndex } = await import('@/lib/search/binary-index-service');

      // 有 sha
      repoFindFirstMock.mockResolvedValueOnce(fakeRepo('repo-sha', 'myorg', 'myrepo', 'sha-999'));
      getAssetMock.mockResolvedValueOnce(Buffer.from('idx-sha'));
      const res1 = await getOrGenerateRepoBinaryIndex('myorg', 'myrepo');
      expect(getAssetMock).toHaveBeenLastCalledWith('myorg', 'myrepo', 'search-index-sha-999.bin');
      expect(res1?.gitSha).toBe('sha-999');

      // 无 sha（null 回退 head）
      repoFindFirstMock.mockResolvedValueOnce(fakeRepo('repo-head', 'myorg', 'myrepo', null));
      getAssetMock.mockResolvedValueOnce(Buffer.from('idx-head'));
      const res2 = await getOrGenerateRepoBinaryIndex('myorg', 'myrepo');
      expect(getAssetMock).toHaveBeenLastCalledWith('myorg', 'myrepo', 'search-index-head.bin');
      expect(res2?.gitSha).toBe('head');
    });
  });

  describe('JIT 运行时委托与 Fail-Open 降级', () => {
    it('JIT miss 优先委托 Go worker-sidecar 原生构建并读取新落盘资产（卸载 Node CPU）', async () => {
      vi.useRealTimers();
      const fakeFreshBuffer = Buffer.from('freshly-built-by-go');
      // 第一次读 miss，sidecar 成功后第二次读 hit
      getAssetMock.mockResolvedValueOnce(null).mockResolvedValueOnce(fakeFreshBuffer);

      const { getOrGenerateRepoBinaryIndex } = await import('@/lib/search/binary-index-service');
      const result = await getOrGenerateRepoBinaryIndex('o', 'r');

      expect(buildRepoBinaryIndexViaSidecarMock).toHaveBeenCalledWith('repo-1');
      expect(result).toEqual({ buffer: fakeFreshBuffer, gitSha: 'abc123' });
      // Node 侧本地整仓打包未被唤醒
      expect(queryRawMock).not.toHaveBeenCalled();
      expect(putAssetMock).not.toHaveBeenCalled();
    });

    it('🧪 [9.4.3.2] JIT 并发 miss 共享同一次 sidecar 委托（single-flight）', async () => {
      vi.useRealTimers();
      let releaseSidecar: (() => void) | null = null;
      buildRepoBinaryIndexViaSidecarMock.mockImplementation(
        () =>
          new Promise<{ built: boolean }>((resolve) => {
            releaseSidecar = () => resolve({ built: true });
          })
      );
      getAssetMock.mockImplementation(async () => {
        return Buffer.from('shared-go-index');
      });
      // 首查 miss 触发委托
      getAssetMock.mockResolvedValueOnce(null);

      const { getOrGenerateRepoBinaryIndex, __pendingIndexRebuildsForTests } = await import(
        '@/lib/search/binary-index-service'
      );

      const p1 = getOrGenerateRepoBinaryIndex('o', 'r');
      const p2 = getOrGenerateRepoBinaryIndex('o', 'r');
      const p3 = getOrGenerateRepoBinaryIndex('o', 'r');

      await new Promise((r) => setTimeout(r, 0));
      expect(releaseSidecar).not.toBeNull();
      releaseSidecar!();
      const results = await Promise.all([p1, p2, p3]);

      expect(buildRepoBinaryIndexViaSidecarMock).toHaveBeenCalledTimes(1);
      for (const r of results) {
        expect(r).not.toBeNull();
        expect(r!.gitSha).toBe('abc123');
      }
      expect(__pendingIndexRebuildsForTests()).toEqual([]);
    });

    it('Sidecar 故障时 Fail-Open 降级至本地 generateRepoBinaryIndex 兜底（保证自愈不中断）', async () => {
      vi.useRealTimers();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      buildRepoBinaryIndexViaSidecarMock.mockRejectedValueOnce(new Error('sidecar unreachable'));

      const { getOrGenerateRepoBinaryIndex } = await import('@/lib/search/binary-index-service');
      const result = await getOrGenerateRepoBinaryIndex('o', 'r');

      expect(buildRepoBinaryIndexViaSidecarMock).toHaveBeenCalledWith('repo-1');
      // 成功降级至本地生成
      expect(queryRawMock).toHaveBeenCalledTimes(1);
      expect(putAssetMock).toHaveBeenCalledTimes(1);
      expect(result).not.toBeNull();
      expect(result?.gitSha).toBe('abc123');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('Sidecar 成功但存储延迟导致二次读取 miss 时，Fail-Open 降级至本地生成兜底', async () => {
      vi.useRealTimers();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // 两次读取均 miss（底层存储刷盘延迟）
      getAssetMock.mockResolvedValue(null);
      buildRepoBinaryIndexViaSidecarMock.mockResolvedValueOnce({ built: true });

      const { getOrGenerateRepoBinaryIndex } = await import('@/lib/search/binary-index-service');
      const result = await getOrGenerateRepoBinaryIndex('o', 'r');

      expect(buildRepoBinaryIndexViaSidecarMock).toHaveBeenCalledWith('repo-1');
      // 触发本地生成兜底
      expect(queryRawMock).toHaveBeenCalledTimes(1);
      expect(putAssetMock).toHaveBeenCalledTimes(1);
      expect(result).not.toBeNull();
      expect(result?.gitSha).toBe('abc123');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Sidecar reported index built for repo repo-1 but asset search-index-abc123.bin not found in storage')
      );
      warnSpy.mockRestore();
    });

    it('SEARCH_INDEX_GO_BUILDER=0 时 JIT miss 直接在本地生成，不发起 Sidecar 委托', async () => {
      vi.useRealTimers();
      process.env.SEARCH_INDEX_GO_BUILDER = '0';
      vi.resetModules();

      const { getOrGenerateRepoBinaryIndex } = await import('@/lib/search/binary-index-service');
      const result = await getOrGenerateRepoBinaryIndex('o', 'r');

      expect(buildRepoBinaryIndexViaSidecarMock).not.toHaveBeenCalled();
      expect(queryRawMock).toHaveBeenCalledTimes(1);
      expect(putAssetMock).toHaveBeenCalledTimes(1);
      expect(result).not.toBeNull();
      expect(result?.gitSha).toBe('abc123');

      vi.resetModules();
    });

    it('对象存储中已有索引时直接命中缓存，不触发 Sidecar 也不触发本地打包', async () => {
      vi.useRealTimers();
      getAssetMock.mockResolvedValue(Buffer.from('cached-index'));
      const { getOrGenerateRepoBinaryIndex } = await import('@/lib/search/binary-index-service');

      const result = await getOrGenerateRepoBinaryIndex('o', 'r');
      expect(result).toEqual({ buffer: Buffer.from('cached-index'), gitSha: 'abc123' });
      expect(buildRepoBinaryIndexViaSidecarMock).not.toHaveBeenCalled();
      expect(queryRawMock).not.toHaveBeenCalled();
      expect(putAssetMock).not.toHaveBeenCalled();
    });
  });
});
