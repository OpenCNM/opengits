import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';

/**
 * assets 引用 GC 单测:
 * maybePruneRepoAssetDir: DB 仍有讲法行不删 / 全空才删 / 失败静默。
 * sweepOrphanAssetDirs: 活跃仓跳过 / 宽限期内跳过 / dryRun 只统计不删 /
 * 非 dryRun 真删。mock prisma 与 fs-extra。
 */

const countMock = vi.fn();
const findManyMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      count: countMock,
      findMany: findManyMock,
    },
  },
}));

// 内存文件系统：Map<绝对路径, {type:'dir'|'file', mtimeMs}>
const memFs = new Map<string, { type: 'dir' | 'file'; mtimeMs: number }>();
const removedPaths: string[] = [];

function repoDirPath(owner: string, repo: string): string {
  return path.join(process.cwd(), 'storage', 'assets', owner, repo);
}

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn(async (p: string) => memFs.has(path.resolve(p))),
    readdir: vi.fn(async (p: string) => {
      const base = path.resolve(p);
      const children = new Set<string>();
      for (const key of memFs.keys()) {
        const rel = path.relative(base, key);
        if (rel && !rel.startsWith('..')) {
          children.add(rel.split(path.sep)[0]);
        }
      }
      return Array.from(children);
    }),
    stat: vi.fn(async (p: string) => {
      const entry = memFs.get(path.resolve(p));
      if (!entry) throw new Error(`ENOENT: ${p}`);
      return {
        isDirectory: () => entry.type === 'dir',
        mtimeMs: entry.mtimeMs,
      };
    }),
    remove: vi.fn(async (p: string) => {
      removedPaths.push(path.resolve(p));
      memFs.delete(path.resolve(p));
    }),
  },
}));

function seedRepoDir(owner: string, repo: string, mtimeMs: number): void {
  const root = path.join(process.cwd(), 'storage', 'assets');
  const ownerDir = path.join(root, owner);
  const dir = path.join(ownerDir, repo);
  memFs.set(root, { type: 'dir', mtimeMs });
  memFs.set(ownerDir, { type: 'dir', mtimeMs });
  memFs.set(dir, { type: 'dir', mtimeMs });
  memFs.set(path.join(dir, 'img.png'), { type: 'file', mtimeMs });
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('maybePruneRepoAssetDir(删除后延迟双检回收)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memFs.clear();
    removedPaths.length = 0;
    process.env.ASSETS_PRUNE_DEFER_MS = '10'; // 压缩 TOCTOU defer 窗口
  });
  afterEach(() => {
    delete process.env.ASSETS_PRUNE_DEFER_MS;
  });

  it('DB 无任何讲法行(count=0)→ 延迟后删除资产目录', async () => {
    seedRepoDir('o1', 'r1', Date.now());
    countMock.mockResolvedValue(0);
    const mod = await import('@/lib/storage/assets-gc');
    mod.maybePruneRepoAssetDir('o1', 'r1');
    await vi.waitFor(() => expect(removedPaths).toContain(repoDirPath('o1', 'r1')), { timeout: 2000, interval: 10 });
  });

  it('defer 窗口后复查已有新讲法落行 → 取消回收（TOCTOU 缓解）', async () => {
    seedRepoDir('o1', 'r2', Date.now());
    // 唯一一次 count（defer 后）发现新讲法行 → 取消删除
    countMock.mockResolvedValue(2);
    const mod = await import('@/lib/storage/assets-gc');
    mod.maybePruneRepoAssetDir('o1', 'r2');
    await new Promise((r) => setTimeout(r, 60));
    expect(removedPaths).toHaveLength(0);
  });

  it('仍有其他讲法引用(count>0)→ 不删', async () => {
    seedRepoDir('o1', 'r2', Date.now());
    countMock.mockResolvedValue(2);
    const mod = await import('@/lib/storage/assets-gc');
    mod.maybePruneRepoAssetDir('o1', 'r2');
    await new Promise((r) => setTimeout(r, 60));
    expect(removedPaths).toHaveLength(0);
  });

  it('目录本就不存在 → 不报错不动作', async () => {
    countMock.mockResolvedValue(0);
    const mod = await import('@/lib/storage/assets-gc');
    mod.maybePruneRepoAssetDir('ghost', 'none');
    await new Promise((r) => setTimeout(r, 60));
    expect(countMock).toHaveBeenCalled();
    expect(removedPaths).toHaveLength(0);
  });
});

describe('sweepOrphanAssetDirs(孤儿目录清扫)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memFs.clear();
    removedPaths.length = 0;
    process.env.ASSETS_GC_DRY_RUN = 'false';
    process.env.ASSETS_ORPHAN_GRACE_DAYS = '7';
  });
  afterEach(() => {
    delete process.env.ASSETS_GC_DRY_RUN;
    delete process.env.ASSETS_ORPHAN_GRACE_DAYS;
  });

  function seedWorld(): void {
    // o-active/r-live: DB 活跃；orphan-old: 无行且超宽限期；orphan-fresh: 无行但在宽限期内
    seedRepoDir('o-active', 'r-live', Date.now());
    seedRepoDir('o-gone', 'old', Date.now() - 8 * DAY_MS);
    seedRepoDir('o-gone', 'fresh', Date.now() - 1 * DAY_MS);
    findManyMock.mockResolvedValue([
      { owner: 'o-active', repo: 'r-live' },
    ]);
  }

  it('活跃仓跳过、超宽期孤儿删除、宽限期内跳过', async () => {
    seedWorld();
    const mod = await import('@/lib/storage/assets-gc');
    const report = await mod.sweepOrphanAssetDirs({ dryRun: false, graceDays: 7 });
    expect(report.scannedDirs).toBe(3);
    expect(report.removedDirs).toBe(1);
    expect(report.skippedByGrace).toBe(1);
    expect(removedPaths).toContain(repoDirPath('o-gone', 'old'));
    expect(removedPaths).not.toContain(repoDirPath('o-gone', 'fresh'));
    expect(removedPaths).not.toContain(repoDirPath('o-active', 'r-live'));
  });

  it('dryRun 只统计不删除', async () => {
    seedWorld();
    const mod = await import('@/lib/storage/assets-gc');
    const report = await mod.sweepOrphanAssetDirs({ dryRun: true, graceDays: 7 });
    expect(report.dryRun).toBe(true);
    expect(report.removedDirs).toBe(1); // 仅统计"将删除"
    expect(removedPaths).toHaveLength(0); // 实际未删
    expect(memFs.has(repoDirPath('o-gone', 'old'))).toBe(true);
  });

  it('默认走 env 门控:ASSETS_GC_DRY_RUN 未设时默认 dry-run', async () => {
    delete process.env.ASSETS_GC_DRY_RUN;
    seedWorld();
    const mod = await import('@/lib/storage/assets-gc');
    const report = await mod.sweepOrphanAssetDirs();
    expect(report.dryRun).toBe(true);
    expect(removedPaths).toHaveLength(0);
  });

  it('graceDays 参数覆盖 env 默认值', async () => {
    seedWorld();
    const mod = await import('@/lib/storage/assets-gc');
    // 宽限期拉长到 30 天 → old(8天) 也在期内
    const report = await mod.sweepOrphanAssetDirs({ dryRun: false, graceDays: 30 });
    expect(report.removedDirs).toBe(0);
    expect(report.skippedByGrace).toBe(2);
  });
});
