/**
 * 进程内 TTL 微缓存（读者热路径的秒级扇出削减）。
 *
 * 与 60s LRU 的 repoPageMetaCache、sha 键不可变的 grounding 缓存构成三级：
 * 本模块服务「短时间内可容忍微陈旧、高频重复键」的读取（如同一章节被
 * 多读者/多次翻页命中）。FIFO 容量上限防长驻进程无界增长。
 */
export interface TtlMicroCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  clear(): void;
  readonly size: number;
}

export function createTtlMicroCache<T>(ttlMs: number, maxEntries = 500): TtlMicroCache<T> {
  const store = new Map<string, { expiresAt: number; value: T }>();
  return {
    get(key: string): T | undefined {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() >= entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: T): void {
      if (store.size >= maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      store.set(key, { expiresAt: Date.now() + ttlMs, value });
    },
    clear(): void {
      store.clear();
    },
    get size(): number {
      return store.size;
    },
  };
}
