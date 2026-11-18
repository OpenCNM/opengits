import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 首页公共数据层单测（P-01）：
 * 排序参数归一化 / take 上限（homeMaxRepos）传递 / 缓存键按 sort 分离。
 * prisma 与 next/cache 全量 mock。
 */

const findManyMock = vi.fn();
const docFindManyMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: { findMany: (...args: unknown[]) => findManyMock(...args) },
    document: { findMany: (...args: unknown[]) => docFindManyMock(...args) },
    tutorialOutline: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

// 记录 unstable_cache 的注册参数；缓存函数直接透传执行
const cacheRegistry: Array<{ keyParts: string[]; options: Record<string, unknown> }> = [];
vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => Promise<unknown>, keyParts: string[], options: Record<string, unknown>) => {
    cacheRegistry.push({ keyParts, options });
    return fn;
  },
}));

vi.mock('@/lib/recommendation/score', () => ({
  fetchMcpHealthForRepos: vi.fn().mockResolvedValue(new Map()),
  computeRecommendationScore: vi.fn(() => ({ total: 0 })),
}));

function repoRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id, owner: 'o', repo: `r-${id}`, branch: 'main', edition: '',
    views: 1, helpfulCount: 0, mcpCallCount: 0,
    gitSha: null, createdAt: new Date(), updatedAt: new Date(),
    reviewPipeline: null, reviewLlm: null, repoProfile: null,
    documents: [{ path: 'docs/zh/intro.md' }],
    _count: { savedRepos: 3 },
    ...over,
  };
}

describe('getPublicHomeData(首页公共数据缓存层)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheRegistry.length = 0;
    findManyMock.mockResolvedValue([]);
    docFindManyMock.mockResolvedValue([]);
  });
  afterEach(() => {
    delete process.env.HOME_MAX_REPOS;
  });

  it('排序归一化:非法值回落 hot;hot 走 views/createdAt 复合排序', async () => {
    const mod = await import('@/lib/home/public-home-data');
    expect(mod.normalizeHomeSort('newest')).toBe('newest');
    expect(mod.normalizeHomeSort('az')).toBe('az');
    expect(mod.normalizeHomeSort('bogus')).toBe('hot');
    expect(mod.normalizeHomeSort(undefined)).toBe('hot');
  });

  it('take 上限生效:查询携带 homeMaxRepos(默认 200)', async () => {
    const mod = await import('@/lib/home/public-home-data');
    await mod.getPublicHomeData('hot');

    const call = findManyMock.mock.calls[0][0];
    expect(call.take).toBe(200);
    expect(call.where).toEqual(
      expect.objectContaining({ isPublic: true, documents: { some: {} } }),
    );
    // hot 排序的复合排序键(与复合索引对齐)
    expect(call.orderBy).toEqual([{ views: 'desc' }, { createdAt: 'desc' }]);
  });

  it('env HOME_MAX_REPOS 可覆盖上限', async () => {
    process.env.HOME_MAX_REPOS = '50';
    vi.resetModules();
    cacheRegistry.length = 0;
    const mod = await import('@/lib/home/public-home-data');
    await mod.getPublicHomeData('newest');
    expect(findManyMock.mock.calls[0][0].take).toBe(50);
  });

  it('不同 sort 注册独立缓存条目(keyParts 含 sort),共享同一失效 tag', async () => {
    vi.resetModules(); // 隔离前序用例残留的进程内缓存注册表
    cacheRegistry.length = 0;
    const mod = await import('@/lib/home/public-home-data');
    await mod.getPublicHomeData('hot');
    await mod.getPublicHomeData('newest');

    const sorts = cacheRegistry.map((c) => c.keyParts);
    expect(sorts.some((k) => k.includes('hot') && k.includes('public-home-data-v6'))).toBe(true);
    expect(sorts.some((k) => k.includes('newest'))).toBe(true);
    for (const c of cacheRegistry) {
      expect(c.options.tags).toContain('home:v2');
      // TTL 兜底过期存在且为正数
      expect(Number(c.options.revalidate)).toBeGreaterThan(0);
    }
  });

  it('基线文档投影:ownerUserId=null 口径分组为 docsByRepoBaseline', async () => {
    docFindManyMock.mockResolvedValue([
      { repositoryId: 'repoA', path: 'docs/zh/a.md', status: 'PROCESSED' },
      { repositoryId: 'repoA', path: 'docs/en/b.md', status: 'PROCESSING' },
      { repositoryId: null, path: 'orphan.md', status: 'PROCESSED' },
    ]);
    findManyMock.mockResolvedValue([repoRow('repoA'), repoRow('repoB')]);

    const mod = await import('@/lib/home/public-home-data');
    const data = await mod.getPublicHomeData('hot');

    expect(data.docsByRepoBaseline['repoA']).toHaveLength(2);
    expect(data.docsByRepoBaseline['repoA'][1]).toEqual({ path: 'docs/en/b.md', status: 'PROCESSING' });
    expect(data.recScores['repoA']).toBe(0);
  });

  it('大纲优先章节数统计:有大纲取 chapters 数量，无大纲回退 baseline 文档数', async () => {
    const { prisma } = await import('@/lib/db');
    (prisma.tutorialOutline.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        repositoryId: 'repoWithOutline',
        chapters: [
          {
            id: 'c1',
            nodes: [
              { documentId: 'd1', headingPath: null, document: { id: 'd1', path: 'docs/1.md', status: 'PROCESSED' } },
              { documentId: 'd2', headingPath: null, document: { id: 'd2', path: 'docs/2.md', status: 'PROCESSED' } },
            ],
          },
          {
            id: 'c2',
            nodes: [
              { documentId: 'd3', headingPath: null, document: { id: 'd3', path: 'docs/3.md', status: 'PROCESSED' } },
            ],
          },
        ],
      },
    ]);
    docFindManyMock.mockResolvedValue([
      { repositoryId: 'repoNoOutline', path: 'docs/a.md', status: 'PROCESSED' },
      { repositoryId: 'repoNoOutline', path: 'docs/b.md', status: 'PROCESSED' },
      { repositoryId: 'repoNoOutline', path: 'docs/c.md', status: 'PROCESSED' },
    ]);
    findManyMock.mockResolvedValue([repoRow('repoWithOutline'), repoRow('repoNoOutline')]);

    const mod = await import('@/lib/home/public-home-data');
    const data = await mod.getPublicHomeData('hot');

    // 有大纲的仓：共 2 章（尽管有 3 个节点）
    expect(data.chapterCountsByRepo['repoWithOutline']).toBe(2);
    expect(data.docsByRepoBaseline['repoWithOutline']).toHaveLength(3);

    // 无大纲的仓：回退物理文档数 3
    expect(data.chapterCountsByRepo['repoNoOutline']).toBe(3);
    expect(data.docsByRepoBaseline['repoNoOutline']).toHaveLength(3);
  });

  it('shelfFeeOverride=0 时首页展示价强制为 0，其余沿用公式计费', async () => {
    vi.resetModules();
    cacheRegistry.length = 0;
    findManyMock.mockResolvedValue([
      { ...repoRow('freeRepo'), transcriptionCreditsEarned: 150, shelfFeeOverride: 0, _count: { savedRepos: 0, documents: 12 } },
      { ...repoRow('paidRepo'), transcriptionCreditsEarned: 150, shelfFeeOverride: null, _count: { savedRepos: 0, documents: 12 } },
    ]);

    const mod = await import('@/lib/home/public-home-data');
    const data = await mod.getPublicHomeData('hot');

    expect(data.shelfFees['freeRepo']).toBe(0);
    expect(data.shelfFees['paidRepo']).toBe(150);
  });
});
