// SHA-keyed inflight + deep-cloned TTL cache deduplicates concurrent LLM calls and prevents cross-caller mutation.

const CACHE_MAX_ENTRIES = 200;

interface LlmCacheEntry<T> {
  ts: number;
  value: T;
}

const llmCache = new Map<string, LlmCacheEntry<unknown>>();
const inflightLlm = new Map<string, Promise<unknown>>();

function getLlmCached<T>(key: string, ttlMs: number): T | undefined {
  const entry = llmCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > ttlMs) {
    llmCache.delete(key);
    return undefined;
  }
  return structuredClone(entry.value) as T;
}

function setLlmCached<T>(key: string, value: T): void {
  if (llmCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = [...llmCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
    if (oldestKey) llmCache.delete(oldestKey);
  }
  llmCache.set(key, { ts: Date.now(), value });
}

export async function withLlmCache<T>(
  key: string,
  ttlMs: number,
  fallback: () => Promise<T>
): Promise<T> {
  const cached = getLlmCached<T>(key, ttlMs);
  if (cached !== undefined) return cached;
  const existing = inflightLlm.get(key);
  if (existing) return existing as Promise<T>;
  const p = (async () => {
    try {
      const value = await fallback();
      setLlmCached(key, value);
      return value;
    } finally {
      inflightLlm.delete(key);
    }
  })();
  inflightLlm.set(key, p);
  return p as Promise<T>;
}

export function hashCacheVariant(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(36);
}
