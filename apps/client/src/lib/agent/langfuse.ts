import { Langfuse } from 'langfuse';
import { PromptRegistry } from '@/lib/prompt-registry';

/**
 * Global Langfuse client singleton with Graceful Optional Integration Guard.
 * If LANGFUSE_SECRET_KEY is not configured or set to placeholder,
 * methods perform safe no-op logging without throwing network errors.
 */

const hasLangfuseConfig = !!(process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_SECRET_KEY !== 'your_key_here');

const createLangfuseClient = () => {
  if (!hasLangfuseConfig) {
    // Return a dummy client that silently ignores trace operations
    return new Proxy({} as Langfuse, {
      get(target, prop) {
        if (prop === 'trace') return () => ({ score: () => {}, span: () => ({ end: () => {} }), update: () => {} });
        if (prop === 'score') return () => {};
        if (prop === 'flush') return async () => {};
        if (prop === 'shutdown') return async () => {};
        return () => {};
      }
    });
  }

  return new Langfuse({
    secretKey: process.env.LANGFUSE_SECRET_KEY!,
    publicKey: process.env.LANGFUSE_PUBLIC_KEY || '',
    baseUrl: process.env.LANGFUSE_BASEURL || 'https://cloud.langfuse.com',
    flushAt: 1, 
  });
};

const globalForLangfuse = globalThis as unknown as {
  langfuse: Langfuse | undefined;
};

export const langfuse = globalForLangfuse.langfuse ?? createLangfuseClient();

if (process.env.NODE_ENV !== 'production') {
  globalForLangfuse.langfuse = langfuse;
}

/**
 * ─────────────────────────────────────────────────────────────
 * Tutor System Prompt 进程内缓存（SCALING_ROADMAP P-08）。
 *
 * 动机：getPrompt 是跨服务网络调用（自建 langfuse 时还可能冷启动/断网），
 * 原实现 await 在 chat 首 token 关键路径上——远端抖动直接放大用户可感延迟。
 *
 * 语义：同步返回缓存值或内置 fallback；远端拉取/刷新全部后台异步。
 * - 未命中 → 立即返回 fallback，同时后台拉取填充；
 * - 已过期 → 继续供旧值，同时后台刷新（stale-while-revalidate）；
 * - 编译失败 → 回落 fallback。断网时首 token 零劣化。
 * ─────────────────────────────────────────────────────────────
 */

const PROMPT_CACHE_TTL_MS = 10 * 60 * 1000;

interface CompilablePrompt {
  compile(variables: Record<string, unknown>): string;
}

const promptCache = new Map<string, { prompt: CompilablePrompt; fetchedAt: number }>();

export interface TutorPromptArgs {
  feynmanMode: boolean;
  owner: string;
  repo: string;
  currentPath?: string | null;
}

/**
 * 兜底 prompt：DB 托管版本（admin 热编辑成果，读内存缓存零开销）优先于代码预设。
 * 修复"伪可编辑陷阱"——此前只读代码预设，admin 编辑 tutor key 保存后运行时永远不生效。
 * DB 缓存未命中时回退代码预设，并触发后台预热（下次请求即用 DB 版本）。
 */
export function buildTutorPromptFallback(args: TutorPromptArgs): string {
  const currentPath = args.currentPath || '';
  const key = tutorPromptKey(args.feynmanMode);
  const vars = { owner: args.owner, repo: args.repo, currentPath };
  const dbCompiled = PromptRegistry.compileFromCacheSync(key, vars);
  if (dbCompiled !== null) return dbCompiled;
  warmDbTutorPromptInBackground(key);
  return PromptRegistry.compilePresetSync(key, vars);
}

function tutorPromptKey(feynmanMode: boolean): string {
  return feynmanMode ? 'tutor_feynman_v1' : 'tutor_system_v1';
}

/** in-flight 去重：TTL 到期瞬间并发请求共享一次后台刷新（原各自起一个 fetch） */
const inflightRefresh = new Map<string, Promise<void>>();

/** DB 托管版本预热去重（PromptRegistry.getCompiledPrompt 填充内存缓存，供同步回退读取） */
const inflightDbWarm = new Map<string, Promise<void>>();

function warmDbTutorPromptInBackground(key: string): void {
  if (inflightDbWarm.has(key)) return;
  const task = (async () => {
    try {
      await PromptRegistry.getCompiledPrompt(key);
    } catch {
      // 容错降级: DB 预热失败保持代码预设兜底（与既有降级语义一致）
    } finally {
      inflightDbWarm.delete(key);
    }
  })();
  inflightDbWarm.set(key, task);
}

function fetchTutorPromptInBackground(key: string): void {
  if (inflightRefresh.has(key)) return;
  warmDbTutorPromptInBackground(key); // Langfuse 主链之外并行保温 DB 兜底链
  const task = (async () => {
    try {
      const prompt = (await langfuse.getPrompt(key)) as unknown as CompilablePrompt;
      // 未配置/哑客户端时 getPrompt 可能返回 undefined——不写入缓存，保持 fallback 路径
      if (!prompt || typeof prompt.compile !== 'function') return;
      promptCache.set(key, { prompt, fetchedAt: Date.now() });
    } catch (err) {
      console.warn(`[Langfuse] background prompt fetch failed for ${key}:`, err instanceof Error ? err.message : err);
    } finally {
      inflightRefresh.delete(key);
    }
  })();
  inflightRefresh.set(key, task);
}

/**
 * 同步获取 tutor system prompt：缓存命中即返回；否则立即返回内置 fallback，
 * 同时后台异步拉取填充；过期供旧值并触发刷新。绝不阻塞、绝不抛错。
 */
export function getCachedTutorPrompt(args: TutorPromptArgs): string {
  const key = tutorPromptKey(args.feynmanMode);
  const vars = { owner: args.owner, repo: args.repo, currentPath: args.currentPath || '' };
  const hit = promptCache.get(key);

  if (!hit) {
    fetchTutorPromptInBackground(key);
    return buildTutorPromptFallback(args);
  }

  if (Date.now() - hit.fetchedAt > PROMPT_CACHE_TTL_MS) {
    fetchTutorPromptInBackground(key); // 过期异步刷新，本轮继续供旧值
  }

  try {
    return hit.prompt.compile(vars);
  } catch (err) {
    console.warn(`[Langfuse] prompt compile failed for ${key}, using fallback:`, err instanceof Error ? err.message : err);
    return buildTutorPromptFallback(args);
  }
}

// 模块加载预热一次（fire-and-forget；失败静默，走 fallback）
fetchTutorPromptInBackground(tutorPromptKey(false));
fetchTutorPromptInBackground(tutorPromptKey(true));

