import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 市场任务进程内异步转录执行器时序单测（transcription-runner.ts）。
 *
 * 租约三防线（该文件头注释的物理契约）：
 * 1. 任务开始前续租（覆盖进程内排队耗时）；
 * 2. 执行期间每 LEASE_RENEW_INTERVAL_MS=10min 续租（fake timers 驱动验证节拍）；
 * 3. 续租失败（租约已丢/网络异常）仅告警不中断——脏写防御交由 settle CAS
 *    失败封闭（Go 侧 MarketSettleRelayTxUpdateJob 的 claimedBy 守卫）。
 * 另覆盖：inFlight Map 共享去重（并发同 jobId 复用同一 Promise）与
 * 信号量并发钳制（MARKET_TRANSCRIPTION_CONCURRENCY 1..8）。
 */

const runStagedMock = vi.fn();
const extendClaimMock = vi.fn();

vi.mock('@/lib/update-market/jobs', () => ({
  runStagedTranscription: (...a: unknown[]) => runStagedMock(...a),
}));

vi.mock('@/engine/market-driver', () => ({
  executeSidecarMarketJobExtendClaim: (...a: unknown[]) => extendClaimMock(...a),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const LEASE_RENEW_INTERVAL_MS = 10 * 60_000;

/** 每个用例取全新模块实例（inFlight Map 与信号量为模块级状态） */
async function freshRunner() {
  vi.resetModules();
  return import('@/lib/update-market/transcription-runner');
}

const flushMicrotasks = () => vi.advanceTimersByTimeAsync(0);

describe('租约三防线：开始前续租 + 执行期节拍续租（fake timers）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    extendClaimMock.mockResolvedValue({ extended: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('开始前立即续租一次（覆盖排队耗时），TTL 取 ENGINE_CONFIG.updateMarket.claimTtlMin', async () => {
    const { enqueueClaimedTranscription, getInFlightTranscription } = await freshRunner();
    const d = deferred<void>();
    runStagedMock.mockReturnValue(d.promise);

    const p = enqueueClaimedTranscription('job-1', 'u-1');
    await flushMicrotasks();

    expect(extendClaimMock).toHaveBeenCalledTimes(1);
    expect(extendClaimMock).toHaveBeenCalledWith('job-1', 'u-1', 30);
    expect(runStagedMock).toHaveBeenCalledTimes(1);
    expect(getInFlightTranscription('job-1')).toBeDefined();

    d.resolve(undefined);
    await p;
  });

  it('执行期每 10min 续租一次，任务结束后定时器彻底清除（无悬挂续租）', async () => {
    const { enqueueClaimedTranscription } = await freshRunner();
    const d = deferred<void>();
    runStagedMock.mockReturnValue(d.promise);

    const p = enqueueClaimedTranscription('job-1', 'u-1');
    await flushMicrotasks();
    expect(extendClaimMock).toHaveBeenCalledTimes(1); // 开始前续租

    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
    expect(extendClaimMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
    expect(extendClaimMock).toHaveBeenCalledTimes(3);
    // 不足一个周期的推进不触发
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS - 1_000);
    expect(extendClaimMock).toHaveBeenCalledTimes(3);

    d.resolve(undefined);
    await p;
    await flushMicrotasks();
    const countAtStop = extendClaimMock.mock.calls.length;

    // 任务完成后连续推进多个周期：续租定时器已被 stop() 清除
    await vi.advanceTimersByTimeAsync(5 * LEASE_RENEW_INTERVAL_MS);
    expect(extendClaimMock).toHaveBeenCalledTimes(countAtStop);
    expect(runStagedMock).toHaveBeenCalledTimes(1);
  });

  it('续租返回 extended=false（租约已丢/过期回池）→ 仅告警不中断，执行仍完成（settle CAS 兜底）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { enqueueClaimedTranscription } = await freshRunner();
      extendClaimMock.mockResolvedValue({ extended: false });
      const d = deferred<void>();
      runStagedMock.mockReturnValue(d.promise);

      const p = enqueueClaimedTranscription('job-lease-lost', 'u-1');
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);

      const leaseLostCalls = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('lease lost for job=job-lease-lost'),
      );
      expect(leaseLostCalls).toHaveLength(1);
      expect(leaseLostCalls[0][0]).toContain('settle CAS will fail-closed');

      // 不中断：转录照常执行并完成
      d.resolve(undefined);
      await expect(p).resolves.toBeUndefined();
      expect(runStagedMock).toHaveBeenCalledWith('job-lease-lost');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('续租网络异常（sidecar 拒绝）→ 仅告警不中断，后续周期继续尝试', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { enqueueClaimedTranscription } = await freshRunner();
      extendClaimMock.mockRejectedValue(new Error('sidecar unreachable'));
      const d = deferred<void>();
      runStagedMock.mockReturnValue(d.promise);

      const p = enqueueClaimedTranscription('job-1', 'u-1');
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);

      const errCalls = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('lease renewal error for job=job-1'),
      );
      expect(errCalls.length).toBeGreaterThanOrEqual(2);

      d.resolve(undefined);
      await expect(p).resolves.toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('inFlight 共享去重：并发同 jobId 复用同一 Promise，runStagedTranscription 仅执行 1 次', async () => {
    const { enqueueClaimedTranscription, getInFlightTranscription } = await freshRunner();
    const d = deferred<void>();
    runStagedMock.mockReturnValue(d.promise);

    const p1 = enqueueClaimedTranscription('job-dup', 'u-1');
    await flushMicrotasks();
    const p2 = enqueueClaimedTranscription('job-dup', 'u-2');
    expect(p2).toBe(p1);
    expect(runStagedMock).toHaveBeenCalledTimes(1);
    expect(getInFlightTranscription('job-dup')).toBe(p1);

    d.resolve(undefined);
    await p1;
    await flushMicrotasks();
    // 完成即摘除在途登记：后续同 jobId 是全新执行（新 Promise、新一次转录）
    expect(getInFlightTranscription('job-dup')).toBeUndefined();
    const p3 = enqueueClaimedTranscription('job-dup', 'u-3');
    expect(p3).not.toBe(p1);
    await flushMicrotasks();
    expect(runStagedMock).toHaveBeenCalledTimes(2);
    await p3;
  });
});

describe('信号量并发钳制（MARKET_TRANSCRIPTION_CONCURRENCY，真实定时器）', () => {
  const CONCURRENCY_ENV = 'MARKET_TRANSCRIPTION_CONCURRENCY';
  let originalEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    extendClaimMock.mockResolvedValue({ extended: true });
    originalEnv = process.env[CONCURRENCY_ENV];
  });
  afterEach(async () => {
    if (originalEnv === undefined) delete process.env[CONCURRENCY_ENV];
    else process.env[CONCURRENCY_ENV] = originalEnv;
    // 兜底收割残留的挂起任务，避免跨用例污染
    await runStagedMock.mock.results
      .filter((r) => r.status === 'pending' && r.value instanceof Promise)
      .map((r) => r.value)
      .map(async (p) => p.catch(() => undefined));
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('并发上限 2：第 3 个任务排队，槽位释放后依序补位', async () => {
    process.env[CONCURRENCY_ENV] = '2';
    const { enqueueClaimedTranscription } = await freshRunner();

    const deferreds = new Map<string, ReturnType<typeof deferred<void>>>();
    const started: string[] = [];
    runStagedMock.mockImplementation((jobId: string) => {
      started.push(jobId);
      const d = deferred<void>();
      deferreds.set(jobId, d);
      return d.promise;
    });

    const ps = [
      enqueueClaimedTranscription('job-a', 'u-1'),
      enqueueClaimedTranscription('job-b', 'u-1'),
      enqueueClaimedTranscription('job-c', 'u-1'),
    ];
    await sleep(30);
    expect(started.slice().sort()).toEqual(['job-a', 'job-b']);

    // 释放 job-a 的槽位 → job-c 补位执行
    deferreds.get('job-a')!.resolve(undefined);
    await ps[0];
    await sleep(30);
    expect(started).toContain('job-c');
    expect(started).toHaveLength(3);

    deferreds.get('job-b')!.resolve(undefined);
    deferreds.get('job-c')!.resolve(undefined);
    await Promise.all(ps);
  });
});
