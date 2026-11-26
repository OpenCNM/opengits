import { MCP_HOT_CACHE_TTL_MS, MCP_HOT_CACHE_MAX_ENTRIES } from '@/lib/constants';

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

  delete(key: string): boolean {
    const deleted = this.store.delete(key);
    this.inFlight.delete(key);
    return deleted;
  }

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

  clear(): void {
    this.store.clear();
    this.inFlight.clear();
  }

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
