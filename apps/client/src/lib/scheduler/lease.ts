import { randomBytes } from 'node:crypto';
import { ignoreBestEffort } from '@/lib/best-effort';
import { callSidecar } from '@/lib/sidecar-client';

const LEASE_OWNER = `worker-${process.pid}-${randomBytes(4).toString('hex')}`;

export function leaseOwner(): string {
  return LEASE_OWNER;
}

// Acquires an exclusive sidecar CAS lease; returns false so overlapping ticks skip cleanly.
export async function acquireLease(key: string, ttlMs: number): Promise<boolean> {
  try {
    const res = await callSidecar<{ acquired: boolean }>(
      '/v1/scheduler/lease/acquire',
      { key, ttlMs, ownerId: LEASE_OWNER },
      { label: 'scheduler-lease' }
    );
    return res.acquired;
  } catch (err) {
    console.warn(
      `[lease] acquire failed for ${key} (skip this cycle):`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

export function leaseTtlFromIntervalMs(intervalMs: number): number {
  return intervalMs * 2;
}

// Owner-scoped release on shutdown; lease expiry recovers if release fails.
export async function releaseLease(key: string): Promise<void> {
  try {
    await callSidecar<{ ok: boolean }>(
      '/v1/scheduler/lease/release',
      { key, ownerId: LEASE_OWNER },
      { label: 'scheduler-lease' }
    );
  } catch {
    ignoreBestEffort();
  }
}
