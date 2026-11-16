import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { MCP_QUERY_STATUS } from '@/lib/constants';

/**
 * ─────────────────────────────────────────────────────────────
 * 推荐引擎 v1：首页「推荐」排序（审核=地板，推荐=排序）。
 *
 * 四组件合计 100，冷启动友好（早期 views 是虚荣指标，绝对保存数与
 * MCP 调用才是真实认可）：
 *   ① 社区认可（30）：savedCount × 系数
 *   ② AI 客户价值（30）：生命周期调用 + 近30天调用 − 盲区率惩罚
 *   ③ 内容基线（25）：双通道审核分；存量无审核分公开仓给中性分
 *   ④ 新鲜度（15）：updatedAt 衰减
 * 权重全部来自 ENGINE_CONFIG.recommendation 中央注册表。
 * v2 方向（记录于基线）：阅读深度、QUIZ 参与、repoType 分桶、推荐徽章。
 * ─────────────────────────────────────────────────────────────
 */

const R = ENGINE_CONFIG.recommendation;

export interface McpHealth {
  /** 近 N 天调用总数 */
  recentCalls: number;
  /** 近 N 天盲区率（BLIND_SPOT / 总数，0-1） */
  blindRate: number;
}

/**
 * 多讲法（edition）聚合主卡的 MCP 健康合并：近期调用求和，盲区率按调用数加权。
 * 纯函数——保证聚合卡与单讲法卡在「AI 客户价值」分量上口径一致（BUG-04 补全）。
 */
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
  /** 「有帮助」票数（与保存数同权计入社区认可） */
  helpfulCount?: number;
  mcpCallCount: number;
  updatedAt: Date | string;
  /** 双通道审核分快照（null = 存量公开仓，审核流上线前发布） */
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

/** 纯函数：单仓推荐分（可单测；mcpHealth 缺省 = 无近期调用） */
export function computeRecommendationScore(
  repo: RecommendationInput,
  mcpHealth: McpHealth = { recentCalls: 0, blindRate: 0 }
): RecommendationScore {
  // ① 社区认可：保存数 + 有帮助票数同权
  const community = Math.min(
    R.communityMax,
    (repo.savedCount + (repo.helpfulCount ?? 0)) * R.communitySaveFactor
  );

  // ② AI 客户价值：存量热度 + 近期活跃 − 盲区惩罚（不为负）
  const mcpValue = clamp(
    Math.min(R.mcpLifetimeMax, repo.mcpCallCount) +
      Math.min(R.mcpRecentMax, mcpHealth.recentCalls) -
      Math.min(R.blindPenaltyMax, mcpHealth.blindRate * R.blindPenaltyFactor),
    0,
    R.mcpLifetimeMax + R.mcpRecentMax
  );

  // ③ 内容基线：存量无审核分公开仓给中性分（视同已过审，不惩罚历史内容）
  const contentBaseline =
    repo.reviewPipelineTotal != null || repo.reviewLlmScore != null
      ? clamp(
          (repo.reviewPipelineTotal ?? 0) * R.pipelineWeight +
            (repo.reviewLlmScore ?? 0) * R.llmWeight,
          0,
          R.contentMax
        )
      : R.legacyNeutralBaseline;

  // ④ 新鲜度：freshWindowDays 内满分，至 staleWindowDays 线性衰减到 0
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

/** 批量拉取公开仓近 N 天 MCP 健康（一条 groupBy，fleet 路由模板 + status 维度） */
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

  // 先按仓累计 total/blind，再一次成稿
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
