/**
 * repo-tools maintenance 域：check_breaking_changes（从 repo-tools.ts 迁入）。
 * 职责：破坏性变更与迁移避坑检索（单仓精搜 + Hub fan-out）。
 */
import {
  searchRepositoryDocs,
  locateRepositorySections,
  LocatorHit,
  DocSearchUnavailableError,
} from '@/lib/mcp/doc-search';
import { recordMcpToolCall } from '@/lib/telemetry/mcp-beacon';
import {
  MCP_FANOUT_PER_REPO_TIMEOUT_MS,
  MCP_FANOUT_MAX_CONCURRENCY,
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
  fallbackWarning,
  buildFanoutDetailBlocks,
} from './shared';

// -------------------------------------------------------------
// check_breaking_changes（破坏性变更与迁移避坑）
// -------------------------------------------------------------

interface BreakingChangesArgs {
  query: string;
  limit?: number;
  detail?: 'locator' | 'full';
  repository?: string;
  token_budget?: number;
}

export async function runBreakingChanges(args: BreakingChangesArgs, extra: any, runtime: RepoRuntime) {
  const startTime = Date.now();
  try {
    return await runBreakingChangesInner(args, extra, runtime, startTime);
  } catch (error) {
    // 检索后端故障 fail-closed：显式 isError + ERROR 遥测，与真盲区（BLIND_SPOT）严格区分
    if (error instanceof DocSearchUnavailableError) {
      
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: Search backend unavailable for breaking-change audit "${args.query}" — this is an infrastructure failure, NOT an empty result. Retry shortly.`,
          },
        ],
        isError: true,
        telemetry: { dimension: 'documents', query: args.query, resultCount: 0, status: 'ERROR', errorMessage: error.message }};
    }
    throw error;
  }
}

async function runBreakingChangesInner(args: BreakingChangesArgs, extra: any, runtime: RepoRuntime, startTime: number) {
  const { query, limit = 5, detail = 'locator', repository } = args;
  const tokenBudget = Math.max(1, Math.floor(args.token_budget ?? 4000));
  const takeLimit = Math.min(Math.max(limit, 1), 5);

  const targets = await resolveSearchTargets(runtime, repository);
  if (targets === null) {
    return refNotFoundError(repository!, runtime);
  }
  if (targets.length === 0) {
    return emptyHubError(runtime);
  }

  // ── 单仓精搜路径 ──
  if (targets.length === 1) {
    const ctx = targets[0];
    const locatorMode = detail === 'locator';

    const docsResults = locatorMode ? [] : await searchRepositoryDocs(ctx.repository.id, `${query} breaking change migration`, takeLimit, undefined, undefined, undefined, undefined, query, runtime.userId);
    const locatorHits = locatorMode ? await locateRepositorySections(ctx.repository.id, `${query} breaking change migration`, Math.max(takeLimit, 5), undefined, undefined, undefined, query, runtime.userId) : [];
    const breakingCount = locatorMode ? locatorHits.length : docsResults.length;

    

    if (breakingCount === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No explicit breaking changes found for "${query}" in ${ctx.owner}/${ctx.repo}.`,
          },
        ],
        telemetry: { dimension: 'documents', resultCount: locatorMode ? locatorHits.length : breakingCount, resultSnapshot: { count: breakingCount, items: locatorMode ? locatorHits.slice(0, 5).map(h => ({ path: h.path, title: h.title })) : docsResults.slice(0, 5).map(item => ({ path: item.path, title: item.title })) } }};
    }

    if (locatorMode) {
      const locatorText = formatLocatorOutput({
        header: `${fallbackWarning(ctx)}Breaking Changes Locator for "${query}" in ${ctx.owner}/${ctx.repo}`,
        hits: locatorHits,
      });
      return {
        content: [{ type: 'text' as const, text: locatorText }],
      };
    }
    let reportText = `🚨 Breaking Changes in ${ctx.owner}/${ctx.repo}:\n\n`;
    for (const item of docsResults) {
      reportText += `### ${item.heading || item.title || item.path}\nPath: ${item.path}\n\n${item.content}\n\n---\n\n`;
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: reportText,
        },
      ],
    };
  }

  // ── 跨库 fan-out 路径（仅 Hub）──
  const perRepoHits = await mapWithConcurrency(
    targets,
    MCP_FANOUT_MAX_CONCURRENCY,
    async (ctx) => {
      try {
        const hits = await withTimeout(
          locateRepositorySections(ctx.repository.id, `${query} breaking change migration`, Math.max(takeLimit, 5), undefined, undefined, undefined, query, runtime.userId),
          MCP_FANOUT_PER_REPO_TIMEOUT_MS,
          [] as LocatorHit[]
        );
        recordMcpToolCall({
          repositoryId: ctx.repository.id,
          toolName: 'check_breaking_changes',
          dimension: 'documents',
          query,
          resultCount: hits.length,
          responseTimeMs: Date.now() - startTime,
          resultSnapshot: { count: hits.length, items: hits.slice(0, 5).map(h => ({ path: h.path, title: h.title })) },
        }).catch(() => {});
        return { ctx, hits };
      } catch (error) {
        // 检索后端故障逐仓上抛（fail-closed）：外层统一转 isError，不吞为空命中
        if (error instanceof DocSearchUnavailableError) {
          recordMcpToolCall({
            repositoryId: ctx.repository.id,
            toolName: 'check_breaking_changes',
            dimension: 'documents',
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
      content: [{ type: 'text' as const, text: `No explicit breaking changes found for "${query}" across ${runtime.label}.` }],
    };
  }

  // 轮2（detail 升级，两轮法）：locator 排序后仅对前 K 个仓取 full 正文
  if (detail === 'full') {
    const detailBlocks = await buildFanoutDetailBlocks({
      perRepoHits,
      expandedQuery: `${query} breaking change migration`,
      rawQuery: query,
      detail: 'full',
      tokenBudget: tokenBudget,
      contentTypes: undefined,
      userId: runtime.userId,
      headerPrefix: 'Cross-Tutorial Breaking Changes',
      hubLabel: runtime.label,
      summaryMode: false,
    });
    if (detailBlocks) {
      return { content: [{ type: 'text' as const, text: detailBlocks }] };
    }
  }

  const fallbackNote = detail === 'full'
    ? '\n\n(Full content unavailable for cross-tutorial audit; pass "repository" to scope into one tutorial for full mode.)'
    : '';
  const fanoutText = formatFanoutLocatorOutput({
    header: `Breaking Changes Locator for "${query}" across ${runtime.label}`,
    hits: mergedHits,
  }) + fallbackNote;

  return {
    content: [{ type: 'text' as const, text: fanoutText }],
  };
}
