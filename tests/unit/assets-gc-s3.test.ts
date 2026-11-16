import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * s3 存储驱动下的孤儿清扫分支：按 assets/{owner}/{repo} 前缀聚合、
 * LastModified 宽限判定、dryRun 只统计、活跃仓跳过。
 */

const findManyMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      count: vi.fn().mockResolvedValue(0),
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}));

/** 模拟 s3 驱动的内存对象桶 */
function makeFakeS3Driver() {
  const objects = new Map<string, Date>();
  return {
    name: 's3' as const,
    objects,
    get: async (k: string) => (objects.has(k) ? Buffer.from('x') : null),
    put: async (k: string) => void objects.set(k, new Date()),
    delete: async (k: string) => void objects.delete(k),
    exists: async (k: string) => objects.has(k),
    listUnder: async (prefix: string) =>
      [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, lastModified]) => ({ key, lastModified })),
    deleteMany: async (keys: string[]) => {
      for (const k of keys) objects.delete(k);
    },
  };
}

type DriverLike = ReturnType<typeof makeFakeS3Driver> | null;

let fakeDriver: DriverLike = null;

vi.mock('@/lib/storage/driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage/driver')>();
  return {
    ...actual,
    getStorageDriver: () => {
      if (!fakeDriver) throw new Error('fake driver not installed');
      return fakeDriver;
    },
  };
});

vi.mock('@/lib/storage/assets-store', () => ({
  activeStorageDriverName: () => fakeDriver?.name ?? 'local',
  assetObjectKey: (o: string, r: string, p: string) => `assets/${o}/${r}/${p}`,
}));

describe('sweepOrphanAssetDirs(s3 驱动分支)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ASSETS_GC_DRY_RUN = 'false';
    findManyMock.mockResolvedValue([{ owner: 'live-o', repo: 'live-r' }]);
  });
  afterEach(() => {
    delete process.env.ASSETS_GC_DRY_RUN;
    fakeDriver = null;
  });

  function seed(now: number) {
    fakeDriver = makeFakeS3Driver();
    // 活跃仓（保留）
    fakeDriver!.objects.set('assets/live-o/live-r/a.png', new Date(now - 10 * DAY));
    // 孤儿且超宽限（删）
    fakeDriver!.objects.set('assets/gone/old/1.png', new Date(now - 8 * DAY));
    fakeDriver!.objects.set('assets/gone/old/sub/2.png', new Date(now - 9 * DAY));
    // 孤儿但在宽限内（留）
    fakeDriver!.objects.set('assets/gone/fresh/1.png', new Date(now - 1 * DAY));
  }

  it('前缀聚合判定:活跃跳过/超宽期整组删除/宽限内保留', async () => {
    const now = Date.now();
    seed(now);
    const mod = await import('@/lib/storage/assets-gc');
    const report = await mod.sweepOrphanAssetDirs({ dryRun: false, graceDays: 7 });

    expect(report.scannedDirs).toBe(3);
    expect(report.removedDirs).toBe(1);
    expect(report.skippedByGrace).toBe(1);
    expect(fakeDriver!.objects.has('assets/gone/old/1.png')).toBe(false);
    expect(fakeDriver!.objects.has('assets/gone/old/sub/2.png')).toBe(false); // 组级整删
    expect(fakeDriver!.objects.has('assets/gone/fresh/1.png')).toBe(true);
    expect(fakeDriver!.objects.has('assets/live-o/live-r/a.png')).toBe(true);
  }, 15000);

  it('dryRun 只统计不删除', async () => {
    const now = Date.now();
    seed(now);
    const mod = await import('@/lib/storage/assets-gc');
    const report = await mod.sweepOrphanAssetDirs({ dryRun: true, graceDays: 7 });
    expect(report.dryRun).toBe(true);
    expect(report.removedDirs).toBe(1);
    expect(fakeDriver!.objects.has('assets/gone/old/1.png')).toBe(true);
  }, 15000);
});
