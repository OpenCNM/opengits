import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * leader 租约单测（Phase 14 单写者收敛至 Go sidecar）：
 * 抢租成功/失败、网络抖动 fail-safe 跳过、租约释放委托。
 */

const callSidecarMock = vi.fn();

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

describe('acquireLease / releaseLease (调度器 leader 租约)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callSidecarMock.mockResolvedValue({ acquired: true, ok: true });
  });

  async function freshLease() {
    vi.resetModules();
    return import('@/lib/scheduler/lease');
  }

  it('抢租成功 → true；委托 /v1/scheduler/lease/acquire', async () => {
    const mod = await freshLease();
    callSidecarMock.mockResolvedValueOnce({ acquired: true });
    await expect(mod.acquireLease('prune-telemetry', 7200_000)).resolves.toBe(true);
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/scheduler/lease/acquire',
      expect.objectContaining({
        key: 'prune-telemetry',
        ttlMs: 7200_000,
        ownerId: mod.leaseOwner(),
      }),
      expect.objectContaining({ label: 'scheduler-lease' }),
    );
  });

  it('抢租未获得（他人健康持有） → false', async () => {
    const mod = await freshLease();
    callSidecarMock.mockResolvedValueOnce({ acquired: false });
    await expect(mod.acquireLease('upstream-check', 1000)).resolves.toBe(false);
  });

  it('Sidecar 调用异常（网络抖动） → false（fail-safe 宁可跳过一轮也不双跑）', async () => {
    const mod = await freshLease();
    callSidecarMock.mockRejectedValueOnce(new Error('sidecar unreachable'));
    await expect(mod.acquireLease('k', 1000)).resolves.toBe(false);
  });

  it('由调度周期推导租约 TTL（周期 × 2）', async () => {
    const mod = await freshLease();
    expect(mod.leaseTtlFromIntervalMs(60_000)).toBe(120_000);
  });

  it('释放租约 → 委托 /v1/scheduler/lease/release', async () => {
    const mod = await freshLease();
    callSidecarMock.mockResolvedValueOnce({ ok: true });
    await mod.releaseLease('test-key');
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/scheduler/lease/release',
      expect.objectContaining({
        key: 'test-key',
        ownerId: mod.leaseOwner(),
      }),
      expect.objectContaining({ label: 'scheduler-lease' }),
    );
  });
});
