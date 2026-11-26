import { z } from 'zod';
import { ignoreBestEffort } from '@/lib/best-effort';
import { generateStructured, trackTokenUsage } from '@/lib/ai';
import { PromptRegistry } from '@/lib/prompt-registry';
import { resolveActiveUserModel, toInjectableStructuredModel } from '@/lib/ai/user-model-resolver';
import { TRANSLATION_LANGUAGES } from '@/lib/constants';
import { buildDirEvidence } from './ingest-mode-arbiter';
import type { DirTreeNode, DirVerdict } from '@/lib/dir-verdict';
import type { GitHubNode } from '@/engine/fetcher';
import type { RepoProfile } from '@/engine/repo-sniffer';

// LLM recommends targetRoot/auxiliaryPaths; deterministic validation grounds paths against the tree and fails closed to null.

const scopeVerdictSchema = z.object({
  targetRoot: z.string().describe('Primary tutorial content root with trailing slash, empty string for repo root'),
  auxiliaryPaths: z.array(z.string()).catch([]).describe('Non-teaching auxiliary directories with trailing slash, empty array if none'),
  rationale: z.string().max(200).catch(''),
});

export interface ScopeVerdict {
  targetRoot: string;
  auxiliaryPaths: string[];
  rationale: string;
}

export interface ArbitrateScopeInput {
  dirTree: DirTreeNode[];
  markdownFiles: GitHubNode[];
  docCodeRatio: RepoProfile['docCodeRatio'];
  owner: string;
  repo: string;
  sha?: string | null;
  userId?: string;
  targetLanguage?: string | null;
  customPrompt?: string | null;
  readmeSnippet?: string | null;
  forceRefresh?: boolean;
}

// Cache successes 24h by SHA, but cap failure debounce at 5m so transient errors do not stick.
export const SCOPE_VERDICT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const SCOPE_VERDICT_FAILURE_TTL_MS = 5 * 60 * 1000;
const SCOPE_VERDICT_CACHE_MAX_ENTRIES = 100;
const scopeVerdictCache = new Map<string, { ts: number; verdict: ScopeVerdict | null }>();
const scopeVerdictInFlight = new Map<string, Promise<ScopeVerdict | null>>();

const normalizeDir = (p: string): string => {
  let dir = (p || '').trim();
  if (!dir || dir === '/') return '';
  if (!dir.endsWith('/')) dir += '/';
  return dir;
};

const existsInTree = (dir: string, dirTree: DirTreeNode[], markdownFiles: GitHubNode[]): boolean => {
  if (dir === '') return true;
  return dirTree.some((n) => n.path === dir || n.path.startsWith(dir)) || markdownFiles.some((n) => n.path.startsWith(dir));
};

export function isProtectedSourceDir(dir: string, repo?: string): boolean {
  const cleanDir = dir.replace(/^\/|\/$/g, '').toLowerCase();
  if (!cleanDir) return true;

  if (repo) {
    const cleanRepo = repo.toLowerCase();
    const normRepo = cleanRepo.replace(/[-_.]/g, '');
    const normDir = cleanDir.replace(/[-_.]/g, '');
    if (
      cleanDir === cleanRepo ||
      normDir === normRepo ||
      cleanDir.startsWith(`${cleanRepo}/`) ||
      normDir.startsWith(`${normRepo}/`)
    ) {
      return true;
    }
  }

  const CORE_SOURCE_NAMES = new Set(['src', 'core', 'lib']);
  const topSegment = cleanDir.split('/')[0];
  if (CORE_SOURCE_NAMES.has(topSegment)) {
    return true;
  }

  return false;
}

export function groundScopeVerdict(
  raw: z.infer<typeof scopeVerdictSchema>,
  dirTree: DirTreeNode[],
  markdownFiles: GitHubNode[],
  options?: { repo?: string }
): ScopeVerdict | null {
  const targetRoot = normalizeDir(raw.targetRoot);
  if (!existsInTree(targetRoot, dirTree, markdownFiles)) return null;

  const seen = new Set<string>();
  const auxiliaryPaths: string[] = [];
  const repo = options?.repo;

  for (const p of raw.auxiliaryPaths ?? []) {
    const dir = normalizeDir(p);
    if (!dir || seen.has(dir)) continue;
    if (!existsInTree(dir, dirTree, markdownFiles)) continue;
    if (dir === targetRoot || targetRoot.startsWith(dir)) continue;

    // Never allow core source directories or the primary package directory to be marked as auxiliary noise.
    if (repo && isProtectedSourceDir(dir, repo)) {
      continue;
    }

    seen.add(dir);
    auxiliaryPaths.push(dir);
  }

  let rationale = (raw.rationale || '').trim();
  if (repo && (rationale.includes('产品代码') || rationale.includes('辅助噪声'))) {
    const cleanRepo = repo.replace(/[-_.]/g, '').toLowerCase();
    if (rationale.toLowerCase().replace(/[-_.]/g, '').includes(cleanRepo)) {
      rationale = rationale
        .replace(/[^、；，,。;\n]*产品代码[^、；，,。;\n]*/g, '')
        .replace(/[^、；，,。;\n]*辅助噪声[^、；，,。;\n]*/g, '')
        .replace(/^[、；，,。;\s]+/, '')
        .replace(/[、；，,。;\s]+$/, '')
        .trim();
      if (!rationale) {
        rationale = '全仓根即教程主体，保留核心源码目录';
      }
    }
  }

  return { targetRoot, auxiliaryPaths, rationale };
}

export function toDirVerdict(verdict: ScopeVerdict): DirVerdict {
  return {
    primaryRoot: verdict.targetRoot,
    candidates: [
      { dir: verdict.targetRoot, lang: null, role: 'primary', confidence: 1, reason: verdict.rationale },
      ...verdict.auxiliaryPaths.map((dir) => ({ dir, lang: null as string | null, role: 'auxiliary' as const, confidence: 1 })),
    ],
  };
}

function cacheVerdict(key: string, verdict: ScopeVerdict | null): void {
  if (scopeVerdictCache.size >= SCOPE_VERDICT_CACHE_MAX_ENTRIES) {
    const oldest = scopeVerdictCache.keys().next().value;
    if (oldest !== undefined) scopeVerdictCache.delete(oldest);
  }
  scopeVerdictCache.set(key, { ts: Date.now(), verdict });
}

export async function arbitrateScopeVerdict(input: ArbitrateScopeInput): Promise<ScopeVerdict | null> {
  const { dirTree, markdownFiles, docCodeRatio, owner, repo, sha, userId, targetLanguage } = input;

  const userModel = await resolveActiveUserModel(userId).catch(() => { ignoreBestEffort(); return null; });
  const injectable = toInjectableStructuredModel(userModel);
  if (!injectable || !userModel) {
    console.log(`[scope-verdict] outcome=no_model repo=${owner}/${repo}`);
    return null;
  }

  console.log(`[scope-verdict] call repo=${owner}/${repo} sha=${sha ?? 'no-sha'} forceRefresh=${Boolean(input.forceRefresh)}`);

  const promptHash = input.customPrompt?.trim() ? `@prompt:${input.customPrompt.trim().slice(0, 32)}` : '';
  const cacheKey = `${owner}/${repo}@${sha ?? 'no-sha'}@model:${userModel.modelId}${promptHash}`;
  if (!input.forceRefresh) {
    const hit = scopeVerdictCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.verdict ? SCOPE_VERDICT_CACHE_TTL_MS : SCOPE_VERDICT_FAILURE_TTL_MS)) {
      console.log(
        `[scope-verdict] outcome=${hit.verdict ? 'cache_hit' : 'cache_failure_ttl'} repo=${owner}/${repo}`
      );
      return hit.verdict ? { ...hit.verdict } : null;
    }
  }

  if (!input.forceRefresh) {
    const pending = scopeVerdictInFlight.get(cacheKey);
    if (pending) return pending;
    const run = arbitrateScopeVerdictUncached(input, cacheKey, injectable).finally(() => {
      if (scopeVerdictInFlight.get(cacheKey) === run) scopeVerdictInFlight.delete(cacheKey);
    });
    scopeVerdictInFlight.set(cacheKey, run);
    return run;
  }
  return arbitrateScopeVerdictUncached(input, cacheKey, injectable);
}

async function arbitrateScopeVerdictUncached(
  input: ArbitrateScopeInput,
  cacheKey: string,
  injectable: NonNullable<ReturnType<typeof toInjectableStructuredModel>>
): Promise<ScopeVerdict | null> {
  const { dirTree, markdownFiles, docCodeRatio, owner, repo, sha, userId, targetLanguage } = input;

  const languageHint =
    targetLanguage && targetLanguage !== TRANSLATION_LANGUAGES.NONE_CODE
      ? `=== 用户期望教程语言 ===\n${targetLanguage}（存在与之匹配的语言镜像目录时优先选为 targetRoot）\n`
      : '';

  const customPromptHint = input.customPrompt?.trim()
    ? `=== 用户定制大纲/教学偏好 ===\n${input.customPrompt.trim()}（请在裁决目标目录与辅助目录时充分考虑用户的定制意图）\n`
    : '';

  const readmeText = (input.readmeSnippet || '').trim();
  const readmeHint = readmeText
    ? `=== 项目 README 摘要（最关键的意图与定位证据） ===\n${readmeText.slice(0, 2500)}`
    : '=== 项目 README 摘要 ===\n（未检测到项目 README）';

  const codeFiles = docCodeRatio?.codeFiles ?? 0;
  const isCodebase = codeFiles > 0 || markdownFiles.length <= 1;
  const codebaseHint = isCodebase
    ? `=== 仓库代码性质提示 ===\n本项目包含程序源码（代码文件数: ${codeFiles}）。若结合 README 研判本项目为软件产品/应用/框架，教程学习目标是全盘源码架构设计，targetRoot 应当输出 ""（全仓根目录 /）；核心源码目录（如与项目同名的包目录、src/、lib/、core/ 等）是代码教学的主题骨干，绝对不是辅助噪声，严禁加入 auxiliaryPaths！\n`
    : '';

  try {
    const compiled = await PromptRegistry.getCompiledPrompt('scout_scope_verdict', {
      owner,
      repo,
      docCodeRatio: JSON.stringify(docCodeRatio ?? {}),
      dirEvidence: buildDirEvidence(dirTree),
      docSamples: markdownFiles.slice(0, 30).map((n) => n.path).join('\n'),
      targetLanguageHint: languageHint,
      customPromptHint,
      readmeHint,
      codebaseHint,
    });

    let raw: z.infer<typeof scopeVerdictSchema> | null = null;
    for (let attempt = 0; attempt < 2 && !raw; attempt++) {
      try {
        const result = await generateStructured({
          model: injectable,
          schema: scopeVerdictSchema,
          prompt: compiled.compiledPrompt,
          disableThinking: true,
        });
        trackTokenUsage(result.usage, { source: 'scout_scope_verdict', userId });
        raw = result.object;
      } catch (err) {
        if (attempt === 1) throw err;
        console.warn('[scope-verdict] 裁决首次调用失败，重试一次:', err);
      }
    }
    if (!raw) throw new Error('scope verdict produced no object');

    const verdict = groundScopeVerdict(raw, dirTree, markdownFiles, { repo });
    cacheVerdict(cacheKey, verdict);
    console.log(
      `[scope-verdict] outcome=${verdict ? 'verdict' : 'ungrounded_rejected'} repo=${owner}/${repo} targetRoot="${verdict?.targetRoot ?? ''}"`
    );
    return verdict ? { ...verdict } : null;
  } catch (err) {
    console.warn('[scope-verdict] 目标目录裁决失败，fail-closed 回落人工选择:', err);
    console.log(`[scope-verdict] outcome=fallback_error repo=${owner}/${repo}`);
    cacheVerdict(cacheKey, null);
    return null;
  }
}
