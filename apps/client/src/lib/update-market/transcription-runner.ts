/**
 * 市场任务进程内异步转录执行器（性能修复 2026-10-13）。
 *
 * 背景：batch-claim / maintainerBackfill 原先 for 循环串行 await runStagedTranscription
 * （每章分钟级 LLM 全链），10 章可达小时级且远超路由 maxDuration——HTTP 连接被
 * 反向代理超时切断后用户侧表现为失败。
 *
 * 语义与防线：
 * - 认领（claimJob CAS）仍由调用方在响应前完成（保留"批量原子认领"语义），
 *   本执行器只负责已被本人认领任务的转录执行；
 * - 信号量限并发（默认 3，MARKET_TRANSCRIPTION_CONCURRENCY，1..8 钳制）；
 * - 租约三防线：任务开始前续租（覆盖排队耗时）→ 执行期间每 10min 续租（覆盖
 *   病态长任务）→ 进程崩溃时 claimedUntil TTL 过期由 Go ReleaseExpiredClaimsSQL
 *   回池（失败封闭）。续租失败（租约已丢）只记录——settle/mark-failed 的 CAS
 *   保证无脏写，最坏浪费已有 LLM 工作；
 * - inFlight Map 与单任务 claim-transcribe POST 共享去重：batch 已入队的任务
 *   被单任务 POST 撞上时复用同一 Promise（天然幂等，杜绝重复 409）。
 * 失败路径不变：runStagedTranscription 内部失败已走 Go mark-failed CAS
 * （仅本人 CLAIMED→FAILED，租约丢失时静默不生效）。
 */
import { ENGINE_CONFIG } from '@/lib/config';

const inFlightTranscriptions = new Map<string, Promise<unknown>>();

export function getInFlightTranscription(jobId: string): Promise<unknown> | undefined {
  return inFlightTranscriptions.get(jobId);
}

export function setInFlightTranscription(jobId: string, p: Promise<unknown>): void {
  inFlightTranscriptions.set(jobId, p);
}

export function deleteInFlightTranscription(jobId: string): void {
  inFlightTranscriptions.delete(jobId);
}

function runnerConcurrency(): number {
  const n = Number(process.env.MARKET_TRANSCRIPTION_CONCURRENCY) || 3;
  return Math.max(1, Math.min(8, Math.floor(n)));
}

/** 租约续期间隔：小于 claim TTL（默认 30min）一个数量级，覆盖长任务 */
const LEASE_RENEW_INTERVAL_MS = 10 * 60_000;

const semaphore: { active: number; queue: Array<() => void> } = { active: 0, queue: [] };

async function acquireSlot(): Promise<void> {
  if (semaphore.active < runnerConcurrency()) {
    semaphore.active += 1;
    return;
  }
  await new Promise<void>((resolve) => semaphore.queue.push(resolve));
  semaphore.active += 1;
}

function releaseSlot(): void {
  semaphore.active -= 1;
  const next = semaphore.queue.shift();
  if (next) next();
}

/**
 * 续租循环：返回 stop 函数。续租失败（租约丢失）仅告警——回池语义交由
 * Go 侧收敛，本进程的 settle CAS 输家路径自然失败。
 */
function startLeaseRenewal(jobId: string, userId: string): () => void {
  const timer = setInterval(async () => {
    try {
      const { executeSidecarMarketJobExtendClaim } = await import('@/engine/market-driver');
      const res = await executeSidecarMarketJobExtendClaim(
        jobId,
        userId,
        ENGINE_CONFIG.updateMarket.claimTtlMin
      );
      if (!res.extended) {
        console.warn(
          `[market-transcription-runner] lease lost for job=${jobId}; settle CAS will fail-closed`
        );
      }
    } catch (err) {
      console.warn(
        `[market-transcription-runner] lease renewal error for job=${jobId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }, LEASE_RENEW_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * 入队一个已认领任务的转录执行（并发受限）。幂等：同 jobId 已在途时复用
 * 现有 Promise（含单任务 claim-transcribe POST 的共享去重）。
 * 失败语义与 runStagedTranscription 一致：rejection 原样上抛（内部已先走
 * mark-failed CAS 落任务 FAILED 终态）；调用方（batch 路由 fire-and-forget
 * 自行 catch 观测、单任务 POST 交由既有错误映射）按需处理。
 */
export function enqueueClaimedTranscription(jobId: string, userId: string): Promise<unknown> {
  const existing = inFlightTranscriptions.get(jobId);
  if (existing) return existing;

  const run = (async () => {
    // 开始前续租：覆盖进程内排队耗时（认领发生在入队前，排队期间租约时钟在走）
    try {
      const { executeSidecarMarketJobExtendClaim } = await import('@/engine/market-driver');
      await executeSidecarMarketJobExtendClaim(
        jobId,
        userId,
        ENGINE_CONFIG.updateMarket.claimTtlMin
      );
    } catch {
      // 续租失败不阻断：租约可能仍在有效窗口内，交由执行期续租与 settle CAS 兜底
    }

    await acquireSlot();
    const stopRenewal = startLeaseRenewal(jobId, userId);
    try {
      const { runStagedTranscription } = await import('@/lib/update-market/jobs');
      await runStagedTranscription(jobId);
    } finally {
      stopRenewal();
      releaseSlot();
    }
  })();

  inFlightTranscriptions.set(jobId, run);
  // 完成即摘除在途登记；rejection 由各调用方处理（此处的派生 Promise 吞掉避免悬空）
  run.finally(() => inFlightTranscriptions.delete(jobId)).catch(() => undefined);
  return run;
}
