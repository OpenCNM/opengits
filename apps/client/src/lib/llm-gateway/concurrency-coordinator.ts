/**
 * apps/client/src/lib/llm-gateway/concurrency-coordinator.ts
 *
 * 用户级 LLM 网关并发流量协调器 (Per-User Concurrency Coordinator with Headroom Reservation)
 *
 * 核心公理与不变式 (Headroom Invariant)：
 * 1. 外部 LLM API (BYOK) 存在物理并发上限 C (默认 3)。
 * 2. 交互型任务 (interactive: 大纲规划/架构着色) 享有保留槽 R (默认 1)；
 *    批处理任务 (batch: 章节转录/概念抽取) 最大并发受限于 B = C - R (默认 2)。
 * 3. 优先级就绪队列 (Priority Wait Queue)：
 *    - interactive 请求到达：若 activeTotal < C，0 延迟立即执行；若已满，排在就绪队列头部，
 *      一旦有连接释放，优先唤醒 interactive；
 *    - batch 请求到达：若 activeBatch >= B 或 activeTotal >= C，必须排队等待，绝不可抢占保留槽；
 * 4. 支持 AbortSignal 取消自动退队，释放回调幂等，无活动状态自动回收防内存泄漏。
 */

type ConcurrencyPriority = 'interactive' | 'batch';

interface CoordinatorConfig {
  maxConcurrency?: number;
  interactiveHeadroom?: number;
}

interface Waiter {
  priority: ConcurrencyPriority;
  resolve: (release: () => void) => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
  cleanup?: () => void;
}

class UserSlotPool {
  private activeTotal = 0;
  private activeBatch = 0;
  private readonly interactiveQueue: Waiter[] = [];
  private readonly batchQueue: Waiter[] = [];
  public lastActiveAt: number = Date.now();

  constructor(
    public readonly maxConcurrency: number = 3,
    public readonly interactiveHeadroom: number = 1,
  ) {
    if (this.maxConcurrency < 1) {
      throw new Error(`maxConcurrency (${maxConcurrency}) must be at least 1`);
    }
    if (this.interactiveHeadroom < 0) {
      throw new Error(`interactiveHeadroom (${interactiveHeadroom}) cannot be negative`);
    }
    if (this.interactiveHeadroom >= this.maxConcurrency) {
      throw new Error(
        `interactiveHeadroom (${interactiveHeadroom}) must be strictly less than maxConcurrency (${maxConcurrency})`,
      );
    }
  }

  get batchLimit(): number {
    return this.maxConcurrency - this.interactiveHeadroom;
  }

  get stats() {
    return {
      activeTotal: this.activeTotal,
      activeBatch: this.activeBatch,
      activeInteractive: this.activeTotal - this.activeBatch,
      interactiveQueueLength: this.interactiveQueue.length,
      batchQueueLength: this.batchQueue.length,
      maxConcurrency: this.maxConcurrency,
      batchLimit: this.batchLimit,
    };
  }

  isIdle(): boolean {
    return (
      this.activeTotal === 0 &&
      this.interactiveQueue.length === 0 &&
      this.batchQueue.length === 0
    );
  }

  acquire(priority: ConcurrencyPriority, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error('Request aborted before slot acquisition'));
    }
    this.lastActiveAt = Date.now();

    // Fast path: can acquire immediately without queuing?
    if (priority === 'interactive') {
      if (this.activeTotal < this.maxConcurrency) {
        this.activeTotal++;
        return Promise.resolve(this.createRelease(priority));
      }
    } else {
      // batch priority
      if (this.activeBatch < this.batchLimit && this.activeTotal < this.maxConcurrency) {
        this.activeTotal++;
        this.activeBatch++;
        return Promise.resolve(this.createRelease(priority));
      }
    }

    // Slow path: must wait in queue
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        priority,
        resolve,
        reject,
        signal,
      };

      if (signal) {
        const onAbort = () => {
          this.removeWaiter(waiter);
          reject(signal.reason ?? new Error('Request aborted while waiting for LLM slot'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => {
          signal.removeEventListener('abort', onAbort);
        };
      }

      if (priority === 'interactive') {
        this.interactiveQueue.push(waiter);
      } else {
        this.batchQueue.push(waiter);
      }
    });
  }

  private removeWaiter(waiter: Waiter) {
    if (waiter.cleanup) {
      waiter.cleanup();
      waiter.cleanup = undefined;
    }
    const targetQueue = waiter.priority === 'interactive' ? this.interactiveQueue : this.batchQueue;
    const idx = targetQueue.indexOf(waiter);
    if (idx !== -1) {
      targetQueue.splice(idx, 1);
    }
  }

  private createRelease(priority: ConcurrencyPriority): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.lastActiveAt = Date.now();

      if (this.activeTotal > 0) {
        this.activeTotal--;
      }
      if (priority === 'batch' && this.activeBatch > 0) {
        this.activeBatch--;
      }

      this.pump();
    };
  }

  private pump() {
    // 1. Interactive 任务拥有最高唤醒优先级（若还有物理容量）
    while (this.interactiveQueue.length > 0 && this.activeTotal < this.maxConcurrency) {
      const waiter = this.interactiveQueue.shift()!;
      if (waiter.cleanup) {
        waiter.cleanup();
        waiter.cleanup = undefined;
      }
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason ?? new Error('Request aborted'));
        continue;
      }

      this.activeTotal++;
      waiter.resolve(this.createRelease('interactive'));
    }

    // 2. Batch 任务在不侵占保留槽的前提下唤醒
    while (
      this.batchQueue.length > 0 &&
      this.activeBatch < this.batchLimit &&
      this.activeTotal < this.maxConcurrency
    ) {
      const waiter = this.batchQueue.shift()!;
      if (waiter.cleanup) {
        waiter.cleanup();
        waiter.cleanup = undefined;
      }
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason ?? new Error('Request aborted'));
        continue;
      }

      this.activeTotal++;
      this.activeBatch++;
      waiter.resolve(this.createRelease('batch'));
    }
  }
}

function parsePositiveInt(val: string | undefined): number | undefined {
  if (!val) return undefined;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseNonNegativeInt(val: string | undefined): number | undefined {
  if (!val) return undefined;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export class ConcurrencyCoordinator {
  private pools = new Map<string, UserSlotPool>();
  private defaultMaxConcurrency: number;
  private defaultInteractiveHeadroom: number;

  constructor(config: CoordinatorConfig = {}) {
    const envMax = parsePositiveInt(process.env.LLM_USER_CONCURRENCY);
    const envHeadroom = parseNonNegativeInt(process.env.LLM_INTERACTIVE_HEADROOM);

    this.defaultMaxConcurrency = config.maxConcurrency ?? envMax ?? 3;
    this.defaultInteractiveHeadroom = config.interactiveHeadroom ?? envHeadroom ?? 1;
  }

  private resolveKey(userId?: string | null, provider?: string | null): string {
    const u = userId?.trim() || 'platform';
    const p = provider?.trim() || 'default';
    return `${u}:${p}`;
  }

  getPool(userId?: string | null, provider?: string | null): UserSlotPool {
    const key = this.resolveKey(userId, provider);
    let pool = this.pools.get(key);
    if (!pool) {
      pool = new UserSlotPool(this.defaultMaxConcurrency, this.defaultInteractiveHeadroom);
      this.pools.set(key, pool);
    }
    return pool;
  }

  async acquire(
    userId: string | null | undefined,
    priority: ConcurrencyPriority,
    options?: { signal?: AbortSignal; provider?: string | null },
  ): Promise<() => void> {
    const pool = this.getPool(userId, options?.provider);
    let rawRelease: () => void;
    try {
      rawRelease = await pool.acquire(priority, options?.signal);
    } catch (err) {
      // 若获取槽位异常（如 AbortSignal 取消），检查池是否空闲，避免挂留死 pool 造成内存泄漏
      if (pool.isIdle()) {
        const key = this.resolveKey(userId, options?.provider);
        this.pools.delete(key);
      }
      throw err;
    }

    return () => {
      rawRelease();
      // 释放后检查是否空闲，自动回收避免长期内存常驻
      if (pool.isIdle()) {
        const key = this.resolveKey(userId, options?.provider);
        this.pools.delete(key);
      }
    };
  }

  /** 清理超过指定闲置时长的 slot pool（默认 10 分钟） */
  evictIdle(maxIdleMs = 10 * 60 * 1000): number {
    const now = Date.now();
    let count = 0;
    for (const [key, pool] of this.pools.entries()) {
      if (pool.isIdle() && now - pool.lastActiveAt >= maxIdleMs) {
        this.pools.delete(key);
        count++;
      }
    }
    return count;
  }

  getActivePoolCount(): number {
    return this.pools.size;
  }
}

/** 全局单例协调器 (网关层单一事实源) */
export const defaultCoordinator = new ConcurrencyCoordinator();
