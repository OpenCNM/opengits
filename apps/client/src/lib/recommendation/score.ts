import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { MCP_QUERY_STATUS } from '@/lib/constants';

const R = ENGINE_CONFIG.recommendation;

export interface McpHealth {
  recentCalls: number;
  blindRate: number;
}

export function mergeMcpHealth(entries: Array<McpHealth | null | undefined>): McpHealth {
  let recentCalls = 0;
  let blindCalls = 0;
  for (const e of entries) {
    if (!e) continue;
    recentCalls += e.recentCalls;
    blindCalls += e.recentCalls * e.blindRate;
  }
  return {
    recentCalls,
    blindRate: recentCalls > 0 ? blindCalls / recentCalls : 0,
  };
}

export interface RecommendationInput {
  savedCount: number;
  helpfulCount?: number;
  mcpCallCount: number;
  updatedAt: Date | string;
  reviewPipelineTotal?: number | null;
  reviewLlmScore?: number | null;
}

export interface RecommendationScore {
  total: number;
  breakdown: {
    community: number;
    mcpValue: number;
    contentBaseline: number;
    freshness: number;
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function computeRecommendationScore(
  repo: RecommendationInput,
  mcpHealth: McpHealth = { recentCalls: 0, blindRate: 0 }
): RecommendationScore {
  const community = Math.min(
    R.communityMax,
    (repo.savedCount + (repo.helpfulCount ?? 0)) * R.communitySaveFactor
  );

  const mcpValue = clamp(
    Math.min(R.mcpLifetimeMax, repo.mcpCallCount) +
      Math.min(R.mcpRecentMax, mcpHealth.recentCalls) -
      Math.min(R.blindPenaltyMax, mcpHealth.blindRate * R.blindPenaltyFactor),
    0,
    R.mcpLifetimeMax + R.mcpRecentMax
  );

  const contentBaseline =
    repo.reviewPipelineTotal != null || repo.reviewLlmScore != null
      ? clamp(
          (repo.reviewPipelineTotal ?? 0) * R.pipelineWeight +
            (repo.reviewLlmScore ?? 0) * R.llmWeight,
          0,
          R.contentMax
        )
      : R.legacyNeutralBaseline;

  const ageDays = (Date.now() - new Date(repo.updatedAt).getTime()) / (24 * 3600 * 1000);
  const freshness =
    ageDays <= R.freshWindowDays
      ? R.freshnessMax
      : clamp(
          R.freshnessMax *
            (1 - (ageDays - R.freshWindowDays) / (R.staleWindowDays - R.freshWindowDays)),
          0,
          R.freshnessMax
        );

  const breakdown = { community, mcpValue, contentBaseline, freshness };
  return {
    total: clamp(
      community + mcpValue + contentBaseline + freshness,
      0,
      R.communityMax + R.mcpLifetimeMax + R.mcpRecentMax + R.contentMax + R.freshnessMax
    ),
    breakdown,
  };
}

export async function fetchMcpHealthForRepos(
  repositoryIds: string[]
): Promise<Map<string, McpHealth>> {
  const result = new Map<string, McpHealth>();
  if (repositoryIds.length === 0) return result;

  const since = new Date(Date.now() - R.mcpRecentWindowDays * 24 * 3600 * 1000);
  const rows = await prisma.mcpCallLog
    .groupBy({
      by: ['repositoryId', 'status'],
      where: { createdAt: { gte: since }, repositoryId: { in: repositoryIds } },
      _count: { id: true },
    })
    .catch(() => [] as Array<{ repositoryId: string | null; status: string; _count: { id: number } }>);

  const acc = new Map<string, { total: number; blind: number }>();
  for (const row of rows) {
    if (!row.repositoryId) continue;
    const entry = acc.get(row.repositoryId) || { total: 0, blind: 0 };
    entry.total += row._count.id;
    if (row.status === MCP_QUERY_STATUS[2]) entry.blind += row._count.id;
    acc.set(row.repositoryId, entry);
  }
  for (const [repoId, { total, blind }] of acc) {
    result.set(repoId, { recentCalls: total, blindRate: total > 0 ? blind / total : 0 });
  }
  return result;
}
