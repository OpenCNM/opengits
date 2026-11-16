// ensureArchive/diffArchives 的 sidecar 分发测试：
// - sidecar 确认归档后，dir 必须按本地挂载路径重算（sidecar 容器路径不可透传）
// - sidecar 失败返回 dir: null（Fail-Open 优雅降级契约）

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/client/src/engine/tarball/archive-sidecar-driver', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../apps/client/src/engine/tarball/archive-sidecar-driver')
  >();
  return {
    ...actual,
    ensureArchiveViaSidecar: vi.fn(async () => ({ dir: '/storage/repos/o/r/abc1234', fromCache: true })),
    diffArchivesViaSidecar: vi.fn(async () => null),
  };
});

vi.mock('../../apps/client/src/engine/diff-driver', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../apps/client/src/engine/diff-driver')
  >();
  return {
    ...actual,
    executeArchiveDiff: vi.fn(async () => ({
      added: new Set(['added.txt']),
      modified: new Set<string>(),
      removed: new Set<string>(),
      renamed: [],
    })),
  };
});

const { ensureArchive, diffArchives } = await import(
  '../../apps/client/src/engine/tarball/archive-store'
);
const driver = await import('../../apps/client/src/engine/tarball/archive-sidecar-driver');
const diffDriver = await import('../../apps/client/src/engine/diff-driver');

describe('ensureArchive dispatch to sidecar', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('1.14.3.2 returns the local mount path when the sidecar confirms the archive (不透传容器路径)', async () => {
    const result = await ensureArchive('o', 'r', 'abc1234');
    expect(result.fromCache).toBe(true);
    // 本地路径按 TARBALL_CACHE.dir（Node 容器 /app/storage/repos）重算，而非透传 sidecar 路径
    expect(result.dir).not.toBe('/storage/repos/o/r/abc1234');
    expect(result.dir!.replace(/\\/g, '/')).toMatch(/\/o\/r\/abc1234$/);
    expect(driver.ensureArchiveViaSidecar).toHaveBeenCalledTimes(1);
  });

  it('maps sidecar skip (dir null) to archive-unavailable semantics', async () => {
    vi.mocked(driver.ensureArchiveViaSidecar).mockResolvedValueOnce({ dir: null, fromCache: false });
    const result = await ensureArchive('o', 'r', 'abc1234');
    expect(result).toEqual({ dir: null, fromCache: false });
  });

  });

describe('diffArchives dispatch to diff-driver', () => {
  it('delegates diff directly to executeArchiveDiff with Fail-Open resilience', async () => {
    const result = await diffArchives('o', 'r', 'abc1234', 'def5678');
    expect(result).not.toBeNull();
    expect(result?.added.has('added.txt')).toBe(true);
    expect(diffDriver.executeArchiveDiff).toHaveBeenCalledWith('o', 'r', 'abc1234', 'def5678');
  });
});
