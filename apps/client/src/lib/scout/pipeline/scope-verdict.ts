import { z } from 'zod';
import { generateStructured, trackTokenUsage } from '@/lib/ai';
import { PromptRegistry } from '@/lib/prompt-registry';
import { resolveActiveUserModel, toInjectableStructuredModel } from '@/lib/ai/user-model-resolver';
import { TRANSLATION_LANGUAGES } from '@/lib/constants';
import { buildDirEvidence } from './ingest-mode-arbiter';
import type { DirTreeNode, DirVerdict } from '@/lib/dir-verdict';
import type { GitHubNode } from '@/engine/fetcher';
import type { RepoProfile } from '@/engine/repo-sniffer';

/**
 * ─────────────────────────────────────────────────────────────
 * Scout 目标目录裁决（LLM 意图判断 → 确定性回查 → fail-closed）
 *
 * 「哪个目录是教程主体」是意图判断（Syntax ≠ Intent）：平铺书仓的正文在
 * 根、翻译仓的正文在语言目录、集中文档仓的正文在 docs/——无法用字母序
 * 或 if-else 穷举（appendix-A 盲选事故的根因，红线三）。判断权归还 LLM，
 * 本文件只保留确定性职责：
 * - 物理证据采集：目录拓扑 + 文档样本（压缩进 prompt，非全树）；
 * - 防幻觉回查门：targetRoot / auxiliaryPaths 必须真实存在于树中；
 * - fail-closed：无模型 / 超时 / schema 漂移返回 null，由用户在确认页
 *   手动选择目录（人是最终闸门，不用规则冒充智能）。
 *
 * 历史注记：scout 内曾有 LLM 目录裁决 runDirVerdict（40~90s 阻塞式，已
 * 删除）。本次重生依赖三点不同：禁思考模式压缩延迟、进程内缓存去重、
 * 裁决仅作推荐而由用户确认页拍板——不阻塞任何流程。
 * ─────────────────────────────────────────────────────────────
 */

/** 严格 targetRoot（漂移必须失败）；辅助清单与理由容错降级（空清单/空串） */
const scopeVerdictSchema = z.object({
  targetRoot: z.string().describe('Primary tutorial content root with trailing slash, empty string for repo root'),
  auxiliaryPaths: z.array(z.string()).catch([]).describe('Non-teaching auxiliary directories with trailing slash, empty array if none'),
  rationale: z.string().max(200).catch(''),
});

export interface ScopeVerdict {
  /** 教程主体根目录（含尾斜杠）；'' 表示全仓根——合法的最终答案 */
  targetRoot: string;
  /** 建议排除的辅助目录（含尾斜杠，已回查真实存在） */
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
  /** 向导的转录目标语言（软提示：翻译仓优先匹配的语言镜像目录） */
  targetLanguage?: string | null;
  /** 用户定制偏好提示词（软提示：按定制意图定制主体或排除项） */
  customPrompt?: string | null;
  /** 项目主 README 摘要（最关键的意图与定位证据，辅助 AI 区分普通工程项目 vs 教程书籍仓） */
  readmeSnippet?: string | null;
  /** 是否强制跳过缓存重新裁决 */
  forceRefresh?: boolean;
}

/** 裁决进程内缓存：成功 24h 同 sha 不重烧；失败仅 5 分钟防抖（瞬时抖动
 *  不放大成 24h 错误分类，对齐 ingest-mode-arbiter 先例） */
export const SCOPE_VERDICT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const SCOPE_VERDICT_FAILURE_TTL_MS = 5 * 60 * 1000;
const SCOPE_VERDICT_CACHE_MAX_ENTRIES = 100;
const scopeVerdictCache = new Map<string, { ts: number; verdict: ScopeVerdict | null }>();

const normalizeDir = (p: string): string => {
  let dir = (p || '').trim();
  if (!dir || dir === '/') return '';
  if (!dir.endsWith('/')) dir += '/';
  return dir;
};

const existsInTree = (dir: string, dirTree: DirTreeNode[], markdownFiles: GitHubNode[]): boolean => {
  // '' 为仓库根，恒为合法
  if (dir === '') return true;
  return dirTree.some((n) => n.path === dir || n.path.startsWith(dir)) || markdownFiles.some((n) => n.path.startsWith(dir));
};

/**
 * 判断目录是否属于受保护的核心源码/主包目录（绝对不可作为 auxiliaryPaths 辅助噪声排除）
 */
export function isProtectedSourceDir(dir: string, repo?: string): boolean {
  const cleanDir = dir.replace(/^\/|\/$/g, '').toLowerCase();
  if (!cleanDir) return true; // 根目录本身受保护

  if (repo) {
    const cleanRepo = repo.toLowerCase();
    const normRepo = cleanRepo.replace(/[-_.]/g, '');
    const normDir = cleanDir.replace(/[-_.]/g, '');
    // 与仓库同名包（如 micrograd/, whisper/, browser_use/, peft/）
    if (
      cleanDir === cleanRepo ||
      normDir === normRepo ||
      cleanDir.startsWith(`${cleanRepo}/`) ||
      normDir.startsWith(`${normRepo}/`)
    ) {
      return true;
    }
  }

  // 通用核心源码顶层目录（如 src/、lib/、core/ 绝不可当辅助噪声排除）
  const CORE_SOURCE_NAMES = new Set(['src', 'core', 'lib']);
  const topSegment = cleanDir.split('/')[0];
  if (CORE_SOURCE_NAMES.has(topSegment)) {
    return true;
  }

  return false;
}

/**
 * 确定性回查门（纯函数）：LLM 输出 → 物理事实校验。
 * - targetRoot 编造 → 整体作废返回 null（fail-closed，不猜替代目录）；
 * - auxiliaryPaths 编造条目剔除；targetRoot 自身/祖先剔除（排除主体等于掏空语料）；
 * - 核心源码包保护：严禁将项目主包与核心代码目录当成辅助噪声排除。
 */
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

    // 核心源码保护门：核心源码目录或与仓库同名的主包绝不可作为辅助噪声被排除
    if (repo && isProtectedSourceDir(dir, repo)) {
      continue;
    }

    seen.add(dir);
    auxiliaryPaths.push(dir);
  }

  let rationale = (raw.rationale || '').trim();
  // 防御性清洗：如果 rationale 中声称核心代码包属于辅助噪声，进行修正清洗，杜绝自相矛盾
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

/** 裁决 → 版本合并契约：主体标 role='primary'（'' 根目录同样合法），辅助目录
 *  由 mergeVerdictIntoVersions 一律不收录（仅供前端排除勾选）。 */
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

/**
 * 作用域裁决主入口：BYOK 单次结构化裁决（禁思考 + 单次重试）。
 * 任何失败（无模型/超时/漂移/编造路径）返回 null —— 无推荐，人工选择。
 */
export async function arbitrateScopeVerdict(input: ArbitrateScopeInput): Promise<ScopeVerdict | null> {
  const { dirTree, markdownFiles, docCodeRatio, owner, repo, sha, userId, targetLanguage } = input;

  // Scout BYOK（中继模式）：用户激活服务商缺失 → 无慢路径可用（不缓存：
  // 用户可能中途配置模型，与 ingest-mode-arbiter 先例一致）
  const userModel = await resolveActiveUserModel(userId).catch(() => null);
  const injectable = toInjectableStructuredModel(userModel);
  if (!injectable || !userModel) {
    // Phase 2 观测：无可用慢路径（BYOK 缺失）——先于缓存，防抖窗口不吞事件
    console.log(`[scope-verdict] outcome=no_model repo=${owner}/${repo}`);
    return null;
  }

  // Phase 2 观测：埋点先于缓存查询（失败防抖 TTL 会吞掉缓存后的失败，后置低估失败率）
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

    // 单次重试（对齐 ingest-mode-arbiter 先例）：瞬时抖动当场恢复
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
