import { Langfuse } from 'langfuse';
import { ignoreBestEffort } from '@/lib/best-effort';
import { PromptRegistry } from '@/lib/prompt-registry';

const hasLangfuseConfig = !!(process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_SECRET_KEY !== 'your_key_here');

const createLangfuseClient = () => {
  if (!hasLangfuseConfig) {
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

// Cache tutor prompts in memory and refresh asynchronously so remote Langfuse latency never stalls first-token streaming.

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

// DB-hosted prompts (warmed into PromptRegistry cache) override static presets so admin edits apply without restarting.
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

// Coalesce concurrent TTL-expiry refreshes into a single in-flight fetch.
const inflightRefresh = new Map<string, Promise<void>>();

const inflightDbWarm = new Map<string, Promise<void>>();

function warmDbTutorPromptInBackground(key: string): void {
  if (inflightDbWarm.has(key)) return;
  const task = (async () => {
    try {
      await PromptRegistry.getCompiledPrompt(key);
    } catch {
      ignoreBestEffort();
    } finally {
      inflightDbWarm.delete(key);
    }
  })();
  inflightDbWarm.set(key, task);
}

function fetchTutorPromptInBackground(key: string): void {
  if (inflightRefresh.has(key)) return;
  warmDbTutorPromptInBackground(key);
  const task = (async () => {
    try {
      const prompt = (await langfuse.getPrompt(key)) as unknown as CompilablePrompt;
      // Skip caching dummy/unconfigured Langfuse clients so fallback presets remain active.
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

export function getCachedTutorPrompt(args: TutorPromptArgs): string {
  const key = tutorPromptKey(args.feynmanMode);
  const vars = { owner: args.owner, repo: args.repo, currentPath: args.currentPath || '' };
  const hit = promptCache.get(key);

  if (!hit) {
    fetchTutorPromptInBackground(key);
    return buildTutorPromptFallback(args);
  }

  if (Date.now() - hit.fetchedAt > PROMPT_CACHE_TTL_MS) {
    fetchTutorPromptInBackground(key);
  }

  try {
    return hit.prompt.compile(vars);
  } catch (err) {
    console.warn(`[Langfuse] prompt compile failed for ${key}, using fallback:`, err instanceof Error ? err.message : err);
    return buildTutorPromptFallback(args);
  }
}

fetchTutorPromptInBackground(tutorPromptKey(false));
fetchTutorPromptInBackground(tutorPromptKey(true));

