// Bounded semaphore runner (1-8) with periodic lease renewal; Go settle/mark-failed CAS prevents dirty writes on lost leases.
import { ENGINE_CONFIG } from '@/lib/config';
import { ignoreBestEffort } from '@/lib/best-effort';

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

export function enqueueClaimedTranscription(jobId: string, userId: string): Promise<unknown> {
  const existing = inFlightTranscriptions.get(jobId);
  if (existing) return existing;

  const run = (async () => {
    try {
      const { executeSidecarMarketJobExtendClaim } = await import('@/engine/market-driver');
      await executeSidecarMarketJobExtendClaim(
        jobId,
        userId,
        ENGINE_CONFIG.updateMarket.claimTtlMin
      );
    } catch {
      ignoreBestEffort();
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
  // Detach rejection handling from the cleanup chain; callers observe the primary promise directly.
  run.finally(() => inFlightTranscriptions.delete(jobId)).catch(ignoreBestEffort);
  return run;
}
