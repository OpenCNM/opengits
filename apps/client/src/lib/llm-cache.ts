// 通用 LLM 结果缓存（按 sha 复用）：metadata AI / 大纲等确定性 LLM 产物。
//
// 语义：sha 即内容指纹——同 sha 必同内容，LLM 结果可安全复用；
// 缓存键由调用方构造（含影响输出的全部维度：sha/prefix/语言/customPrompt）。
// 与 profile-cache 同模式：进程内 Map + TTL + LRU 上限 + 深拷贝防串染。

const CACHE_MAX_ENTRIES = 200;

interface LlmCacheEntry<T> {
  ts: number;
  value: T;
}

const llmCache = new Map<string, LlmCacheEntry<unknown>>();
/** 进行中的同 key LLM 调用（inflight 去重）：防止预生成与 route 并发时重复跑 LLM */
const inflightLlm = new Map<string, Promise<unknown>>();

/** 命中返回深拷贝；未命中/过期返回 undefined */
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

/** 命中复用；未命中执行 fallback 并写入缓存。inflight 去重：同 key 并发只跑一次 */
export async function withLlmCache<T>(
  key: string,
  ttlMs: number,
  fallback: () => Promise<T>
): Promise<T> {
  const cached = getLlmCached<T>(key, ttlMs);
  if (cached !== undefined) return cached;
  // 同 key 已在进行中 → 复用其 Promise（防并发重复 LLM，如 scout 预生成与 route 同时触发）
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

/** 轻量字符串哈希（customPrompt 等变体维度进缓存键） */
export function hashCacheVariant(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(36);
}
