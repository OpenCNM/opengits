import { MCP_HOT_CACHE_TTL_MS, MCP_HOT_CACHE_MAX_ENTRIES } from '@/lib/constants';

/**
 * ─────────────────────────────────────────────────────────────
 * 简易 TTL + 容量上限缓存（零依赖，进程内）
 *
 * 为单实例长驻进程的热路径读多写少查询设计（MCP stateless 重建链是首个消费方）：
 * - TTL 过期惰性删除；容量满时先清扫过期项、仍满则按插入序淘汰最旧
 * - getOrLoad 单飞（in-flight 去重）：并发冷启动同 key 只触发一次 loader，
 *   防缓存击穿（Agent 客户端突发同仓请求的典型形态）
 * - loader 抛错不缓存、不共享：失败直接向上传播，下次重试
 *
 * 不适合：需要跨实例一致性的数据（多副本场景应换 Redis 驱动，见 SCALING_ROADMAP B2）
 * ─────────────────────────────────────────────────────────────
 */
interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<V> {
  private store = new Map<string, CacheEntry<V>>();
  private inFlight = new Map<string, Promise<V>>();

  constructor(
    private readonly ttlMs: number = MCP_HOT_CACHE_TTL_MS,
    private readonly maxEntries: number = MCP_HOT_CACHE_MAX_ENTRIES
  ) {}

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: V, customTtlMs?: number): void {
    // 容量保护：先清扫过期项，仍满则淘汰最旧（Map 保持插入序）
    if (!this.store.has(key) && this.store.size >= this.maxEntries) {
      this.sweepExpired();
      while (this.store.size >= this.maxEntries) {
        const oldest = this.store.keys().next().value;
        if (oldest === undefined) break;
        this.store.delete(oldest);
      }
    }
    const ttl = customTtlMs ?? this.ttlMs;
    this.store.set(key, { value, expiresAt: Date.now() + ttl });
  }

  /** 删除指定 key（显式失效） */
  delete(key: string): boolean {
    const deleted = this.store.delete(key);
    this.inFlight.delete(key);
    return deleted;
  }

  /** 读穿透加载（单飞）：命中直接返回；未命中且无在途请求时触发 loader 并缓存结果（含 null/undefined） */
  async getOrLoad(
    key: string,
    loader: () => Promise<V>,
    customTtlMs?: (value: V) => number | undefined
  ): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    let run: Promise<V>;
    run = loader()
      .then((value) => {
        // 仅当当前 inFlight 仍是本 Promise 时才回写，防止在途期间已被 delete/invalidate 导致脏数据写回
        if (this.inFlight.get(key) === run) {
          const ttl = customTtlMs ? customTtlMs(value) : undefined;
          this.set(key, value, ttl);
        }
        return value;
      })
      .finally(() => {
        if (this.inFlight.get(key) === run) {
          this.inFlight.delete(key);
        }
      });
    this.inFlight.set(key, run);
    return run;
  }

  /** 清空（测试与显式失效用） */
  clear(): void {
    this.store.clear();
    this.inFlight.clear();
  }

  /** 当前条目数（测试/观测用） */
  get size(): number {
    return this.store.size;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }
}
