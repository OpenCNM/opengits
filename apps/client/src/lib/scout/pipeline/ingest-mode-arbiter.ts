import { z } from 'zod';
import { generateStructured, trackTokenUsage } from '@/lib/ai';
import { PromptRegistry } from '@/lib/prompt-registry';
import { resolveActiveUserModel, toInjectableStructuredModel } from '@/lib/ai/user-model-resolver';
import { isIngestModeGrayZone } from '@/engine/repo-sniffer';
import type { RepoProfile } from '@/engine/repo-sniffer';
import type { GitHubNode } from '@/engine/fetcher';
import type { DirTreeNode } from '@/lib/dir-verdict';

/**
 * ─────────────────────────────────────────────────────────────
 * 仓库形态灰区仲裁（快筛 → LLM 慢路径 → fail-closed）
 *
 * 规则把"文档数微弱多数 + docs/ 在场"的仓库锁进 text_only（教程仓保护），
 * 无法区分「产品代码库带手册」与「书籍仓带示例代码」——这是意图判断
 * （Syntax ≠ Intent），刚性阈值越权裁决即红线三违例（cline/cline 案例：
 * 144 篇手册 vs 127 个引擎文件，整条代码管线被排除在教学外）。
 *
 * 分工（三层各归其位）：
 * - 确定性快筛：isIngestModeGrayZone 只看物理质量（代码字节数/文件数），
 *   显然情况零 LLM 直判（不对称计算公理）；
 * - LLM 仲裁：灰区时依据目录结构+物理统计裁决教学主体（意图判断归 LLM）；
 * - 确定性漏斗：严格 schema（无 catch 容错——裁决会重路由整条管线，
 *   漂移必须 fail-closed 回落规则裁定），Go 侧 mergeProvidedProfile
 *   另有物理反证闸门兜底。
 * ─────────────────────────────────────────────────────────────
 */

/** 严格 schema：灰区裁决重路由整条管线，输出漂移必须显式失败而非静默默认。 */
const arbitrationSchema = z.object({
  teachingFocus: z.enum(['code', 'docs']),
  rationale: z.string().max(200),
});

export type ArbitrationVerdict = z.infer<typeof arbitrationSchema>;

export interface ArbitrateIngestModeInput {
  profile: RepoProfile;
  dirTree: DirTreeNode[];
  markdownFiles: GitHubNode[];
  owner: string;
  repo: string;
  sha?: string | null;
  userId?: string;
}

export interface ArbitrateIngestModeResult {
  profile: RepoProfile;
  /** 灰区且 LLM 成功给出裁决（profile 可能被改写为 hybrid） */
  arbitrated: boolean;
  /** 灰区命中但 LLM 失败/无模型（fail-closed 保持规则裁定） */
  fallback?: boolean;
  rationale?: string;
}

/**
 * 裁决派生（纯函数）：teachingFocus=code → hybrid（灰区保证 docFiles≥5，
 * 文档必在场 → hybrid 而非 code_only，代码做骨干章节、手册做附页），
 * 同时清空 textRoot——否则目录推荐首选仍是"正文内容 (docs/)"，用户确认
 * 后 scopePrefix 锁死 docs 子树，代码再次被关在门外（换壳复现原缺陷）；
 * teachingFocus=docs → 维持规则裁定 text_only（LLM 看过代码质量证据后
 * 仍认定教学主体是文档——书籍仓保护经意图确认后成立）。
 */
export function deriveArbitratedProfile(
  profile: RepoProfile,
  verdict: ArbitrationVerdict
): RepoProfile {
  if (verdict.teachingFocus !== 'code') return profile;
  return { ...profile, ingestMode: 'hybrid', repoType: 'codebase', textRoot: '' };
}

/** 目录证据表：深度优先展平，浅层优先、活跃内容多的目录优先，封顶防 token 膨胀。 */
export function buildDirEvidence(dirTree: DirTreeNode[], maxDirs = 60): string {
  const rows: Array<{
    path: string;
    depth: number;
    mdCount: number;
    codeCount?: number;
    primaryLang?: string;
    keyFiles?: string[];
    totalFiles: number;
  }> = [];
  const walk = (nodes: DirTreeNode[]) => {
    for (const n of nodes) {
      rows.push({
        path: n.path,
        depth: n.depth,
        mdCount: n.mdCount,
        codeCount: n.codeCount,
        primaryLang: n.primaryLang,
        keyFiles: n.keyFiles,
        totalFiles: n.totalFiles,
      });
      if (n.children.length > 0) walk(n.children);
    }
  };
  walk(dirTree);
  rows.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    const aActivity = (a.codeCount ?? 0) + a.mdCount;
    const bActivity = (b.codeCount ?? 0) + b.mdCount;
    if (aActivity !== bActivity) return bActivity - aActivity;
    return b.totalFiles - a.totalFiles;
  });
  return rows
    .slice(0, maxDirs)
    .map((r) => {
      const details: string[] = [];
      if (r.codeCount && r.codeCount > 0) {
        const lang = r.primaryLang ? `${r.primaryLang} ` : '';
        const samples = r.keyFiles && r.keyFiles.length > 0 ? ` [${r.keyFiles.join(', ')}]` : '';
        details.push(`${r.codeCount} ${lang}code files${samples}`);
      }
      if (r.codeCount !== undefined) {
        details.push(`${r.mdCount} docs`);
      } else if (r.totalFiles > 0) {
        details.push(`${r.mdCount}/${r.totalFiles} docs`);
      } else {
        details.push(`${r.mdCount} docs`);
      }
      return `${r.path} | ${details.join(', ')} | depth ${r.depth}`;
    })
    .join('\n');
}

/** 仲裁进程内缓存：成功裁决（hybrid/docs）24h 内同 sha 不重烧；失败仅 5 分钟
 * 防抖——LLM 瞬时抖动若按成功 TTL 缓存，一次网络故障会被放大成同 sha
 * 24h 的错误分类（fail-closed 回落 text_only），重试永远命中失败缓存。 */
export const ARBITRATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const ARBITRATION_FAILURE_TTL_MS = 5 * 60 * 1000;
const ARBITRATION_CACHE_MAX_ENTRIES = 100;
const arbitrationCache = new Map<string, { ts: number; verdict: ArbitrationVerdict | null }>();

/**
 * 灰区仲裁主入口：非灰区原样返回（零 LLM）；灰区交 LLM 裁决；
 * 任何失败（无模型/超时/schema 漂移）fail-closed 保持规则裁定 text_only。
 */
export async function arbitrateIngestMode(
  input: ArbitrateIngestModeInput
): Promise<ArbitrateIngestModeResult> {
  const { profile, dirTree, markdownFiles, owner, repo, sha, userId } = input;

  if (!isIngestModeGrayZone(profile)) {
    return { profile, arbitrated: false };
  }

  // Phase 2 观测：埋点先于缓存查询——失败防抖 TTL(5min) 会吞掉缓存命中后的
  // 失败重试，后置埋点将系统性低估灰区失败率（Phase 3 扩枚举决策数据失真）
  console.log(`[ingest-arbiter] grayZoneHit=true repo=${owner}/${repo} sha=${sha ?? 'no-sha'}`);

  const cacheKey = `${owner}/${repo}@${sha ?? 'no-sha'}`;
  const hit = arbitrationCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < (hit.verdict ? ARBITRATION_CACHE_TTL_MS : ARBITRATION_FAILURE_TTL_MS)) {
    if (!hit.verdict) {
      console.log('[ingest-arbiter] outcome=cache_failure_ttl repo=' + owner + '/' + repo);
      return { profile, arbitrated: false, fallback: true };
    }
    console.log(`[ingest-arbiter] outcome=cache_hit verdict=${hit.verdict.teachingFocus} repo=${owner}/${repo}`);
    return {
      profile: deriveArbitratedProfile(profile, hit.verdict),
      arbitrated: hit.verdict.teachingFocus === 'code',
      rationale: hit.verdict.rationale,
    };
  }

  try {
    // Scout BYOK（中继模式）：用户激活服务商缺失 → 无慢路径可用，回落规则裁定
    // （不缓存：用户可能中途配置模型，与 aiSniffCache 先例一致）
    const userModel = await resolveActiveUserModel(userId).catch(() => null);
    const injectable = toInjectableStructuredModel(userModel);
    if (!injectable) {
      console.log(`[ingest-arbiter] outcome=fallback_no_model repo=${owner}/${repo}`);
      return { profile, arbitrated: false, fallback: true };
    }

    const compiled = await PromptRegistry.getCompiledPrompt('ingest_mode_arbitration', {
      owner,
      repo,
      docCodeRatio: JSON.stringify(profile.docCodeRatio),
      dirEvidence: buildDirEvidence(dirTree),
      docSamples: markdownFiles.slice(0, 30).map((n) => n.path).join('\n'),
    });

    // 单次重试（对齐转录 grounding gate"重调一次"先例）：瞬时抖动当场恢复，
    // 不落入失败防抖窗口；两连败才 fail-closed 回落规则裁定
    let verdict: ArbitrationVerdict | null = null;
    for (let attempt = 0; attempt < 2 && !verdict; attempt++) {
      try {
        const result = await generateStructured({
          model: injectable,
          schema: arbitrationSchema,
          prompt: compiled.compiledPrompt,
          disableThinking: true,
        });
        trackTokenUsage(result.usage, { source: 'scout_ingest_mode_arbitration', userId });
        verdict = result.object;
      } catch (err) {
        if (attempt === 1) throw err;
        console.warn('[ingest-mode-arbiter] 仲裁首次调用失败，重试一次:', err);
      }
    }
    if (!verdict) throw new Error('arbitration produced no verdict');

    cacheVerdict(arbitrationCache, cacheKey, verdict);
    console.log(`[ingest-arbiter] outcome=verdict verdict=${verdict.teachingFocus} repo=${owner}/${repo}`);
    return {
      profile: deriveArbitratedProfile(profile, verdict),
      arbitrated: verdict.teachingFocus === 'code',
      rationale: verdict.rationale,
    };
  } catch (err) {
    console.warn('[ingest-mode-arbiter] 灰区仲裁失败，fail-closed 回落规则裁定:', err);
    console.log(`[ingest-arbiter] outcome=fallback_error repo=${owner}/${repo}`);
    cacheVerdict(arbitrationCache, cacheKey, null);
    return { profile, arbitrated: false, fallback: true };
  }
}

function cacheVerdict(
  cache: Map<string, { ts: number; verdict: ArbitrationVerdict | null }>,
  key: string,
  verdict: ArbitrationVerdict | null
) {
  if (cache.size >= ARBITRATION_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { ts: Date.now(), verdict });
}
