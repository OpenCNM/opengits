import { randomBytes } from 'node:crypto';
import { callSidecar } from '@/lib/sidecar-client';

/**
 * ─────────────────────────────────────────────────────────────
 * 调度器 leader 租约（由 Go worker-sidecar 单写者落库）。
 *
 * 租约语义（CAS + 唯一约束兜底）：
 * - 抢租/续租：UPDATE WHERE key AND (自己持有 OR 已过期)；
 *   未命中则 INSERT（唯一键冲突 = 他人持有未过期 → false）。
 * - 到期自愈：持有者崩溃后 lockedUntil 过期，任意实例可抢。
 * - 同实例续租幂等：ownerId 匹配即续，无需等待过期。
 * ─────────────────────────────────────────────────────────────
 */

const LEASE_OWNER = `worker-${process.pid}-${randomBytes(4).toString('hex')}`;

export function leaseOwner(): string {
  return LEASE_OWNER;
}

/**
 * 尝试获取/续租某任务的 leader 租约。
 * @param key 任务标识（与 task-registry name 一致）
 * @param ttlMs 租约时长；调用方约定 = 调度周期 × 2（覆盖单轮超时余量）
 * @returns true = 本实例获得本轮执行权
 */
export async function acquireLease(key: string, ttlMs: number): Promise<boolean> {
  try {
    const res = await callSidecar<{ acquired: boolean }>(
      '/v1/scheduler/lease/acquire',
      { key, ttlMs, ownerId: LEASE_OWNER },
      { label: 'scheduler-lease' }
    );
    return res.acquired;
  } catch (err) {
    // 冲突或网络抖动按未获锁处理——宁可跳过一轮也不双跑
    console.warn(
      `[lease] acquire failed for ${key} (skip this cycle):`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** 由调度周期推导租约 TTL（周期 × 2） */
export function leaseTtlFromIntervalMs(intervalMs: number): number {
  return intervalMs * 2;
}

/**
 * 释放本进程持有的租约（ownerId 限定——只会释放自己的，不动他人）。
 * 优雅退出时调用：避免"owner 含 pid+random、重启后新 owner 抢不到"
 * 导致的后台调度空转至 TTL 耗尽（prune TTL 48h → 重启后最长停摆 ~47h）。
 */
export async function releaseLease(key: string): Promise<void> {
  try {
    await callSidecar<{ ok: boolean }>(
      '/v1/scheduler/lease/release',
      { key, ownerId: LEASE_OWNER },
      { label: 'scheduler-lease' }
    );
  } catch {
    // 释放失败无碍：租约到期自愈，仅损失一段空转窗口
  }
}
