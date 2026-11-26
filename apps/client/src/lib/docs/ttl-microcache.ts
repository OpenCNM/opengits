// Bounded FIFO TTL cache prevents unbounded growth in long-lived worker processes.
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
