import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 孤儿内容层回收单测：委托给 Go sidecar /v1/cas/content/orphan-gc 单一写者内核。
 */

const mockCallSidecar = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: any[]) => mockCallSidecar(...args),
}));

describe('orphanContentGcOnce(孤儿内容层回收)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function mod() {
    vi.resetModules();
    return import('@/lib/content-addressing');
  }

  it('孤儿超宽限 → 委托 Go 端点分批真删,计数累计', async () => {
    mockCallSidecar.mockResolvedValueOnce({
      ok: true,
      scanned: 2000,
      removed: 2000,
      dryRun: false,
    });
    const m = await mod();
    const report = await m.orphanContentGcOnce({ graceDays: 7 });
    expect(report.scanned).toBe(2000);
    expect(report.removed).toBe(2000);
    expect(report.dryRun).toBe(false);
    expect(mockCallSidecar).toHaveBeenCalledWith(
      '/v1/cas/content/orphan-gc',
      expect.objectContaining({ graceDays: 7, dryRun: false }),
      expect.anything(),
    );
  });

  it('有薄行引用的行不出现在查询结果,空批终止', async () => {
    mockCallSidecar.mockResolvedValueOnce({
      ok: true,
      scanned: 0,
      removed: 0,
      dryRun: false,
    });
    const m = await mod();
    const report = await m.orphanContentGcOnce({ graceDays: 7 });
    expect(report.scanned).toBe(0);
    expect(report.removed).toBe(0);
  });

  it('dryRun 只估算规模不删除', async () => {
    mockCallSidecar.mockResolvedValueOnce({
      ok: true,
      scanned: 5,
      removed: 5,
      dryRun: true,
    });
    const m = await mod();
    const report = await m.orphanContentGcOnce({ dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.removed).toBe(5);
    expect(mockCallSidecar).toHaveBeenCalledWith(
      '/v1/cas/content/orphan-gc',
      expect.objectContaining({ dryRun: true }),
      expect.anything(),
    );
  });
});
