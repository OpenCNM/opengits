import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchRepoDocPageMetadata,
  clearRepoDocPageMetaCacheForTest,
} from '@/lib/docs/docs-page-loader';
import { prisma } from '@/lib/db';
import * as repoMaintainer from '@/lib/repository-maintainer';

vi.mock('@/lib/db', () => ({
  prisma: {
    importUpdateRun: {
      findMany: vi.fn(),
    },
    document: {
      count: vi.fn(),
    },
    repository: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/repository-maintainer', () => ({
  resolveMaintainerUserId: vi.fn(),
}));

describe('Docs Page Loader Repo Metadata Cache (Unit 3.3 · H-10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRepoDocPageMetaCacheForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('🧪 [3.3.1.2 · HIGH] fetchRepoDocPageMetadata 采用 60s LRU 进程内缓存，翻页跳过仓级查询', async () => {
    vi.mocked(prisma.importUpdateRun.findMany).mockResolvedValue([
      {
        id: 'run-1',
        fromSha: 'sha-1',
        toSha: 'sha-2',
        finishedAt: new Date(),
        createdAt: new Date(),
        stats: {},
        plan: {},
        user: { name: 'Alice', email: 'alice@example.com' },
      } as any,
    ]);
    vi.mocked(repoMaintainer.resolveMaintainerUserId).mockResolvedValue('user-alice');

    // 第一次翻页读取（章节 1）：未命中缓存，执行完整的仓级关联查询
    const meta1 = await fetchRepoDocPageMetadata('repo-123', 'owner', 'repo', true, true);
    expect(meta1.maintainerId).toBe('user-alice');
    expect(meta1.syncHistory).toHaveLength(1);
    expect(prisma.importUpdateRun.findMany).toHaveBeenCalledTimes(1);
    expect(repoMaintainer.resolveMaintainerUserId).toHaveBeenCalledTimes(1);

    // 第二次翻页读取（章节 2）：命中 60s 内存缓存，跳过所有仓级查询！
    const meta2 = await fetchRepoDocPageMetadata('repo-123', 'owner', 'repo', true, true);
    expect(meta2).toEqual(meta1);
    expect(prisma.importUpdateRun.findMany).toHaveBeenCalledTimes(1);
    expect(repoMaintainer.resolveMaintainerUserId).toHaveBeenCalledTimes(1);

    // 第三次翻页读取（章节 3）：再次命中缓存
    const meta3 = await fetchRepoDocPageMetadata('repo-123', 'owner', 'repo', true, true);
    expect(meta3).toEqual(meta1);
    expect(prisma.importUpdateRun.findMany).toHaveBeenCalledTimes(1);

    // 清空测试缓存后再次访问：重新触发查询
    clearRepoDocPageMetaCacheForTest();
    const meta4 = await fetchRepoDocPageMetadata('repo-123', 'owner', 'repo', true, true);
    expect(meta4).toEqual(meta1);
    expect(prisma.importUpdateRun.findMany).toHaveBeenCalledTimes(2);
    expect(repoMaintainer.resolveMaintainerUserId).toHaveBeenCalledTimes(2);
  });
});
