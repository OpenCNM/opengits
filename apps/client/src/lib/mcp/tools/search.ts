/**
 * repo-tools search 域：search 及 search_docs / search_architecture / search_code_examples
 * 维度检索（单仓精搜 + Hub 跨库 fan-out）（从 repo-tools.ts 迁入）。
 * 职责：查询词扩展、维度配置（SEARCH_KINDS）、locator/summary/full 三档输出、
 * code 维度弱命中降级、fan-out 合并归因与概念依赖提示。
 */
import { prisma } from '@/lib/db';
import { TtlCache } from '@/lib/cache/ttl-cache';
import {
  searchRepositoryDocs,
  locateRepositorySections,
  LocatorHit,
  DocSearchUnavailableError,
  injectConceptDependencyHint,
  injectConceptEnrichments,
  rerankChunkResults,
} from '@/lib/mcp/doc-search';
import { recordMcpToolCall } from '@/lib/telemetry/mcp-beacon';
import { summarizeDocChunk } from '@/lib/token-counter';
import {
  MCP_FANOUT_PER_REPO_TIMEOUT_MS,
  MCP_FANOUT_MAX_CONCURRENCY,
  MCP_FANOUT_DETAIL_REPOS,
  MCP_FANOUT_DETAIL_MIN_BUDGET,
  DIMENSION_TO_CONTENT_TYPES,
} from '@/lib/constants';
import {
  RepoRuntime,
  withTimeout,
  mapWithConcurrency,
  formatLocatorOutput,
  formatFanoutLocatorOutput,
  resolveSearchTargets,
  refNotFoundError,
  emptyHubError,
  resolveArchitectureTopologyBlock,
  fallbackWarning,
  buildFanoutDetailBlocks,
} from './shared';

interface ExpandedQuery {
  expandedQuery: string;
  keywords: string[];
  /** GlobalConcept 词表确定性扩展的归因（结果页脚标注，保证可解释） */
  aliasSources: string[];
}

// CJK 宽字符类（汉+假名+谚文+扩展区），与 doc-search locatorKeywords 锁步——
// 中文查询 token 必须进入词表扩展面（中文盲区是本扩展的首要受众）
const QUERY_TOKEN_RE = /[a-zA-Z0-9_.-]{2,}|[\u4e00-\u9fa5\u3040-\u30ff\u3400-\u4dbf\uf900-\ufaff\uac00-\ud7af]{2,}/g;

function extractQueryKeywords(rawQuery: string): string[] {
  if (!rawQuery || typeof rawQuery !== 'string') return [];
  const keywordSet = new Set<string>();
  for (const token of rawQuery.match(QUERY_TOKEN_RE) || []) {
    keywordSet.add(token);
  }
  return Array.from(keywordSet);
}

/** GlobalConcept 词表热缓存：token 组 → 命中概念（60s TTL，读多写少） */
const aliasExpansionCache = new TtlCache<Array<{ canonicalName: string; aliases: string[] }>>(60_000, 256);

/**
 * 受控查询扩展（中文/转述盲区的确定性桥接）：
 * 查询 token 命中 GlobalConcept.canonicalName/aliases（用户词表，非框架硬编码）时，
 * 将别名/正名并入 keywords——仅用于 locator 重排与 Stage 3 token 面，不改写主查询语义。
 * 框架特定同义词注入仍然禁止（杜绝的是硬编码词表；此处为用户自维护的确定性词表）。
 */
export async function expandSearchQuery(rawQuery: string): Promise<ExpandedQuery> {
  if (!rawQuery || typeof rawQuery !== 'string') {
    return { expandedQuery: '', keywords: [], aliasSources: [] };
  }
  const baseKeywords = extractQueryKeywords(rawQuery);
  const cacheKey = [...baseKeywords].sort().join('\u0000');
  const expansions = await aliasExpansionCache.getOrLoad(cacheKey, async () => {
    if (baseKeywords.length === 0) return [];
    return prisma.globalConcept
      .findMany({
        where: {
          OR: [
            { canonicalName: { in: baseKeywords, mode: 'insensitive' } },
            { aliases: { hasSome: baseKeywords } },
          ],
        },
        select: { canonicalName: true, aliases: true },
        take: 8,
      })
      .catch(() => [] as Array<{ canonicalName: string; aliases: string[] }>);
  });

  const keywordSet = new Set(baseKeywords);
  const aliasSources: string[] = [];
  for (const gc of expansions) {
    const additions = [gc.canonicalName, ...gc.aliases].filter(
      (term) => term && !keywordSet.has(term)
    );
    if (additions.length > 0) {
      aliasSources.push(`"${gc.canonicalName}"`);
      for (const term of additions) keywordSet.add(term);
    }
  }

  // 保留用户真实查询语义：主查询仍是原文；扩展词供定位与重排使用
  return { expandedQuery: rawQuery.trim(), keywords: Array.from(keywordSet), aliasSources };
}

// -------------------------------------------------------------
// 搜索工具（search_docs / search_architecture / search_code_examples）
// -------------------------------------------------------------

interface SearchKindConfig {
  dimension: string;
  contentTypes?: string[];
  headerPrefix: string;
  supportsSummary: boolean;
  /** 名词短语，用于跨库无结果文案 */
  noun: string;
  singleScopeHeader: string;
  fanoutHeader: string;
  /** 单仓无结果文案（保留各工具原有措辞） */
  noResult: (query: string, scope: string, effectiveVersion?: string) => string;
}

const SEARCH_KINDS: Record<'docs' | 'architecture' | 'code' | 'gotchas', SearchKindConfig> = {
  docs: {
    dimension: 'all',
    contentTypes: undefined,
    headerPrefix: 'Search Results',
    supportsSummary: true,
    noun: 'documentation chunks',
    singleScopeHeader: 'Search Results',
    fanoutHeader: 'Cross-Tutorial Search Results',
    noResult: (query, scope, effectiveVersion) =>
      `No relevant documentation chunks found for query: "${query}" in ${scope}${effectiveVersion ? ` (Version: ${effectiveVersion})` : ''}. Try listing documents or checking the overview.`,
  },
  architecture: {
    dimension: 'architecture',
    contentTypes: DIMENSION_TO_CONTENT_TYPES.architecture as string[],
    headerPrefix: 'Architecture & Design Search Results',
    supportsSummary: false,
    noun: 'architecture or system design documentation',
    singleScopeHeader: 'Architecture & Design Search Results',
    fanoutHeader: 'Cross-Tutorial Architecture Search Results',
    noResult: (query, scope) =>
      `No architecture or system design documentation found for: "${query}" in ${scope}.`,
  },
  code: {
    dimension: 'code',
    contentTypes: DIMENSION_TO_CONTENT_TYPES.code as string[],
    headerPrefix: 'Code Examples & Implementation Results',
    supportsSummary: false,
    noun: 'code examples or API reference documentation',
    singleScopeHeader: 'Code Examples & Implementation Results',
    fanoutHeader: 'Cross-Tutorial Code Examples Results',
    noResult: (query, scope) =>
      `No code examples or API reference documentation found for: "${query}" in ${scope}.`,
  },
  gotchas: {
    dimension: 'documents',
    contentTypes: undefined,
    headerPrefix: 'Breaking Changes & Gotchas Locator',
    supportsSummary: false,
    noun: 'breaking changes or migration gotchas',
    singleScopeHeader: 'Breaking Changes & Gotchas Locator',
    fanoutHeader: 'Cross-Tutorial Breaking Changes Results',
    noResult: (query, scope) =>
      `No explicit breaking changes or gotchas found for: "${query}" in ${scope}.`,
  },
};

interface SearchToolArgs {
  query: string;
  token_budget?: number;
  detail?: 'locator' | 'summary' | 'full';
  repository?: string;
  /** 讲法 key（Hub 模式与 repository 搭配：等价 repository 的 "owner/repo@edition" 引用） */
  edition?: string;
}

export async function runSearchTool(
  args: SearchToolArgs,
  extra: any,
  runtime: RepoRuntime,
  toolName: 'search' | 'search_docs' | 'search_architecture' | 'search_code_examples',
  kind: keyof typeof SEARCH_KINDS
) {
  const startTime = Date.now();
  try {
    return await runSearchToolInner(args, extra, runtime, toolName, kind, startTime);
  } catch (error) {
    // 检索后端故障 fail-closed：显式 isError + ERROR 遥测，与真盲区（BLIND_SPOT）严格区分
    if (error instanceof DocSearchUnavailableError) {
      return {
        telemetry: { resultCount: 0, status: 'ERROR' as const, errorMessage: error.message, query: args.query, dimension: SEARCH_KINDS[kind].dimension },
        content: [
          {
            type: 'text' as const,
            text: `Error: Search backend unavailable for "${args.query}" — this is an infrastructure failure, NOT an empty result. Retry shortly, or use outline/read to browse structure directly.`,
          },
        ],
        isError: true,
      };
    }
    throw error;
  }
}

async function runSearchToolInner(
  args: SearchToolArgs,
  extra: any,
  runtime: RepoRuntime,
  toolName: 'search' | 'search_docs' | 'search_architecture' | 'search_code_examples',
  kind: keyof typeof SEARCH_KINDS,
  startTime: number
) {
  const { query, token_budget = 4000, detail = 'locator', repository, edition } = args;
  const cfg = SEARCH_KINDS[kind];

  const targets = await resolveSearchTargets(runtime, repository, edition);
  if (targets === null) {
    return refNotFoundError(repository!, runtime);
  }
  if (targets.length === 0) {
    return emptyHubError(runtime);
  }

  // ── 单仓精搜路径（Hub 传了 repository 时同样走此路径）──
  if (targets.length === 1) {
    const ctx = targets[0];
    const effectiveVersion = ctx.targetVersionLabel;
    const locatorMode = detail === 'locator';
    // 讲法归因：讲法行在 header 追加（单仓内全部结果同讲法，header 一次即可）
    const editionSuffix = ctx.editionLabel ? ` (讲法: ${ctx.editionLabel})` : '';

    const { expandedQuery, aliasSources } = await expandSearchQuery(query);
    // fail-loud：显式请求的讲法/版本回退时在结果头部注入警告
    const fbWarn = fallbackWarning(ctx);

    // code 维度弱命中降级：纯 code 类型结果的最佳 gram 命中数低于全类型检索时，
    // 采用全类型结果（教程章节主体常为 prose，如 ai-agent-book chapter4 的 90 个 chunk
    // 全为 prose，严格类型过滤会永久漏掉「工具设计规范」类内容；similarity 在关键词路径
    // 饱和于 0.95，故以 matchCount 作为判别信号）
    const codeFallback = async () => {
      if (locatorMode) {
        return locateRepositorySections(ctx.repository.id, expandedQuery, 15, effectiveVersion, undefined, undefined, query, runtime.userId);
      }
      return rerankChunkResults(await searchRepositoryDocs(ctx.repository.id, expandedQuery, 6, effectiveVersion, undefined, token_budget, undefined, query, runtime.userId), query);
    };

    let results: Awaited<ReturnType<typeof searchRepositoryDocs>> = [];
    let locatorHits: LocatorHit[] = [];
    if (locatorMode) {
      locatorHits = await locateRepositorySections(ctx.repository.id, expandedQuery, 15, effectiveVersion, cfg.contentTypes, undefined, query, runtime.userId);
      if (kind === 'code' && locatorHits.length === 0) {
        locatorHits = (await codeFallback()) as LocatorHit[];
      }
    } else {
      results = rerankChunkResults(await searchRepositoryDocs(ctx.repository.id, expandedQuery, 6, effectiveVersion, cfg.contentTypes, token_budget, undefined, query, runtime.userId), query);
      if (kind === 'code' && results.length > 0) {
        results = await fallbackToUnfilteredCodeResults(results, ctx.repository.id, expandedQuery, effectiveVersion, token_budget, query, runtime.userId);
      }
    }

    let archBlock = '';
    if (cfg.dimension === 'architecture') {
      archBlock = resolveArchitectureTopologyBlock(ctx.owner, ctx.repo, ctx.repository.repoProfile, query);
    }

    if (locatorMode ? locatorHits.length === 0 : results.length === 0) {
      if (archBlock) {
        return {
          telemetry: { resultCount: 1, query, expandedQuery, dimension: cfg.dimension },
          content: [
            {
              type: 'text' as const,
              text: `${archBlock}\n\n---\n\n${cfg.noResult(query, `${ctx.owner}/${ctx.repo}`, effectiveVersion)}`,
            },
          ],
        };
      }
      return {
        telemetry: { resultCount: 0, query, expandedQuery, dimension: cfg.dimension },
        content: [
          {
            type: 'text' as const,
            text: cfg.noResult(query, `${ctx.owner}/${ctx.repo}`, effectiveVersion),
          },
        ],
      };
    }
    if (locatorMode) {
      let locatorText = formatLocatorOutput({
        header: `${fbWarn}${cfg.singleScopeHeader} for "${query}" across ${ctx.owner}/${ctx.repo}${effectiveVersion ? ` (Version: ${effectiveVersion})` : ''}${editionSuffix} [Locator Mode]`,
        hits: locatorHits,
      });
      if (archBlock) {
        locatorText = `${archBlock}\n\n---\n\n${locatorText}`;
      }
      // 导师卡片 + 依赖提示（⚡ 前置知识）：单次概念解析合并注入，避免重复 matchConceptNode 查询
      locatorText = await injectConceptEnrichments(ctx.repository.id, query, locatorText);
      if (aliasSources.length > 0) {
        locatorText += `\n\n(Keyword expansion via GlobalConcept aliases: ${aliasSources.join(', ')}. Pass a more exact term to disable.)`;
      }
      return {
        telemetry: {
          resultCount: locatorHits.length,
          query,
          expandedQuery,
          dimension: cfg.dimension,
          resultSnapshot: { count: locatorHits.length, items: locatorHits.slice(0, 5).map(h => ({ path: h.path, title: h.title, score: h.similarity })) },
        },
        content: [{ type: 'text' as const, text: locatorText }],
      };
    }
    let rawCharTotal = 0;
    let outputText = '';
    if (archBlock) {
      outputText += `${archBlock}\n\n---\n\n`;
    }
    outputText += `${fbWarn}${cfg.singleScopeHeader} for "${query}" across ${ctx.owner}/${ctx.repo}${effectiveVersion ? ` (Version: ${effectiveVersion})` : ''}${editionSuffix}${detail === 'summary' ? ' [Summary Mode]' : ''}:\n\n`;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      rawCharTotal += (r.content || '').length;
      const chunkText = detail === 'summary' ? summarizeDocChunk(r.content || '') : r.content;
      const slugPath = (r.path || '').replace(/\.mdx?$/, '').replace(/^docs\//, '');
      outputText += `--- Result ${i + 1} (Score: ${(r.similarity * 100).toFixed(1)}%) ---\n`;
      outputText += `Document: ${r.title || r.path} [Path: ${r.path}]\n`;
      if (r.heading) {
        outputText += `Section Heading: ${r.heading}\n`;
      }
      outputText += `Web Link: /docs/${ctx.owner}/${ctx.repo}/${slugPath}\n`;
      outputText += `\n${chunkText}\n\n`;
    }

    // 导师卡片 + 图谱依赖提示（⚡ 前置知识）合并为单次概念解析注入
    outputText = await injectConceptEnrichments(ctx.repository.id, query, outputText);
    if (aliasSources.length > 0) {
      outputText += `\n\n(Keyword expansion via GlobalConcept aliases: ${aliasSources.join(', ')}. Pass a more exact term to disable.)`;
    }

    const estimatedTokensSaved = detail === 'summary' ? Math.max(0, Math.round((rawCharTotal - outputText.length) * 0.25)) : 0;
    return {
      telemetry: {
        resultCount: results.length,
        query,
        expandedQuery,
        dimension: cfg.dimension,
        tokensSaved: estimatedTokensSaved,
        resultSnapshot: { count: results.length, items: results.slice(0, 5).map(r => ({ path: r.path, title: r.title, score: r.similarity })) },
      },
      content: [
        {
          type: 'text' as const,
          text: outputText,
        },
      ],
    };
  }

  // ── 跨库 fan-out 路径（仅 Hub；listRepositories 已按讲法折叠——每仓只搜主讲法行）──
  const { expandedQuery } = await expandSearchQuery(query);
  const perRepoHits = await mapWithConcurrency(
    targets,
    MCP_FANOUT_MAX_CONCURRENCY,
    async (ctx) => {
      try {
        const hits = await withTimeout(
          locateRepositorySections(ctx.repository.id, expandedQuery, 6, ctx.targetVersionLabel, cfg.contentTypes, undefined, query, runtime.userId),
          MCP_FANOUT_PER_REPO_TIMEOUT_MS,
          [] as LocatorHit[]
        );
        recordMcpToolCall({
          repositoryId: ctx.repository.id,
          toolName,
          dimension: cfg.dimension,
          query,
          expandedQuery,
          resultCount: hits.length,
          toVersion: ctx.targetVersionLabel,
          tokenBudget: token_budget,
          responseTimeMs: Date.now() - startTime,
          resultSnapshot: { count: hits.length, items: hits.slice(0, 5).map(h => ({ path: h.path, title: h.title, score: h.similarity })) },
        }).catch(() => {});
        return { ctx, hits };
      } catch (error) {
        // 检索后端故障逐仓上抛（fail-closed）：外层统一转 isError，不吞为空命中
        if (error instanceof DocSearchUnavailableError) {
          recordMcpToolCall({
            repositoryId: ctx.repository.id,
            toolName,
            dimension: cfg.dimension,
            query,
            resultCount: 0,
            status: 'ERROR',
            errorMessage: error.message,
            responseTimeMs: Date.now() - startTime,
          }).catch(() => {});
          throw error;
        }
        return { ctx, hits: [] as LocatorHit[] };
      }
    }
  );

  const mergedHits = perRepoHits
    .flatMap(({ ctx, hits }) => hits.map(h => ({ ...h, owner: ctx.owner, repo: ctx.repo })))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 10);

  if (mergedHits.length === 0) {
    return {
      content: [{ type: 'text' as const, text: `No relevant ${cfg.noun} found across ${runtime.label} for: "${query}". Try search with different wording, or pass "repository" to scope into one tutorial.` }],
    };
  }

  // Hub fan-out 依赖提示：逐仓按 query 匹配概念并取前置知识，带 [Source: owner/repo] 归因
  const hintTexts = await mapWithConcurrency(
    perRepoHits.filter(({ hits }) => hits.length > 0),
    MCP_FANOUT_MAX_CONCURRENCY,
    async ({ ctx }) => injectConceptDependencyHint(ctx.repository.id, query, '', `${ctx.owner}/${ctx.repo}`)
  );
  const fanoutHints = hintTexts.filter((t): t is string => Boolean(t)).join('\n');

  // 讲法折叠提示：书架内有多讲法仓库时，告知可用 "owner/repo@edition" 精确指定
  const multiEditionTargets = targets.filter((t) => (t.editionSiblingCount ?? 0) > 0);
  const editionHint = multiEditionTargets.length > 0
    ? `\n\n(部分仓库存在多种转录讲法，已按你在读的讲法检索；可用 "owner/repo@edition" 形式的 repository 参数指定其他讲法，讲法 key 见 list_resources。)`
    : '';

  // ── 轮2（detail 升级，两轮法）：locator 排序后仅对前 K 个仓取 summary/full 正文 ──
  if (detail !== 'locator') {
    const detailBlocks = await buildFanoutDetailBlocks({
      perRepoHits,
      expandedQuery,
      rawQuery: query,
      detail,
      tokenBudget: token_budget,
      contentTypes: cfg.contentTypes,
      userId: runtime.userId,
      headerPrefix: cfg.fanoutHeader,
      hubLabel: runtime.label,
      summaryMode: detail === 'summary',
    });
    if (detailBlocks) {
      return {
        content: [{ type: 'text' as const, text: detailBlocks + editionHint }],
      };
    }
    // 轮2 全部失败（sidecar 不可用等）：回落轮1 locator 结果并显式提示
    const fanoutText =
      formatFanoutLocatorOutput({
        header: `${cfg.fanoutHeader} for "${query}" across ${runtime.label} [Locator Mode]`,
        hits: mergedHits,
      }) + fanoutHints;
    return {
      content: [
        {
          type: 'text' as const,
          text:
            fanoutText +
            editionHint +
            `\n\n(${detail} content unavailable for cross-tutorial results; pass "repository" to scope into one tutorial for ${detail} mode.)`,
        },
      ],
    };
  }

  const fanoutText =
    formatFanoutLocatorOutput({
      header: `${cfg.fanoutHeader} for "${query}" across ${runtime.label} [Locator Mode]`,
      hits: mergedHits,
    }) + fanoutHints;

  return {
    content: [{ type: 'text' as const, text: fanoutText + editionHint }],
  };
}


export async function runSearch(args: any, extra: any, runtime: RepoRuntime) {
  const mode = args.filter || args.mode || 'all';
  if (mode === 'gotchas') {
    const { runBreakingChanges } = await import('./maintenance');
    return runBreakingChanges(args, extra, runtime);
  }
  if (mode === 'concept') {
    if (runtime.multiRepo && !args.repository && runtime.userId) {
      const { findConceptAcrossBookshelf, formatCrossRepoConceptSearch } = await import('@/lib/mcp/cross-repo-tools');
      const hits = await findConceptAcrossBookshelf(runtime.userId, args.query);
      const gcIds = Array.from(new Set(hits.map((h) => h.globalConceptId).filter(Boolean))) as string[];
      const gcs =
        gcIds.length > 0
          ? await prisma.globalConcept.findMany({
              where: { id: { in: gcIds } },
              select: { id: true, canonicalName: true, aliases: true },
            })
          : [];
      const gcMap = new Map(gcs.map((g) => [g.id, { canonicalName: g.canonicalName, aliases: g.aliases }]));
      const text = formatCrossRepoConceptSearch(args.query, hits, gcMap);
      return { content: [{ type: 'text' as const, text }] };
    }
    return runSearchTool(args, extra, runtime, 'search', 'docs');
  }
  const dimension = mode === 'all' ? 'docs' : mode;
  return runSearchTool(args, extra, runtime, 'search', dimension as any);
}

async function fallbackToUnfilteredCodeResults(
  currentResults: Awaited<ReturnType<typeof searchRepositoryDocs>>,
  repositoryId: string,
  expandedQuery: string,
  effectiveVersion: string | undefined,
  tokenBudget: number,
  query: string,
  userId: string | undefined
): Promise<Awaited<ReturnType<typeof searchRepositoryDocs>>> {
  const unfiltered = await searchRepositoryDocs(repositoryId, expandedQuery, 6, effectiveVersion, undefined, tokenBudget, undefined, query, userId);
  if (unfiltered.length === 0) return currentResults;

  const bestFiltered = Math.max(...currentResults.map((r) => r.matchCount ?? r.ftsRank ?? r.similarity ?? 0));
  const bestUnfiltered = Math.max(...unfiltered.map((r) => r.matchCount ?? r.ftsRank ?? r.similarity ?? 0));
  if (bestUnfiltered > bestFiltered) {
    return rerankChunkResults(unfiltered, query);
  }
  return currentResults;
}

