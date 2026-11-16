import { callSidecar } from '@/lib/sidecar-client';

export {
  TIER_LIMITS,
  isPlanTier,
  tierLimitsOf,
  isAdminRole,
  meetsTierRequirement,
} from '@/lib/tier-limits';
export type { PlanTier } from '@/lib/tier-limits';

/**
 * tier 变更时同步用户配额字段为注册表默认值（rpm / 每日配额 / tokenCap 三项全同步）。
 * 仅在调用方未显式传配额时套用（admin 管理端的显式覆盖优先，下沉至 Go sidecar /v1/user/update）。
 */
export async function applyTierDefaults(userId: string, tier: import('./tier-limits').PlanTier): Promise<void> {
  const { TIER_LIMITS } = await import('./tier-limits');
  const limits = TIER_LIMITS[tier];
  await callSidecar(
    '/v1/user/update',
    {
      id: userId,
      dailyMcpQuota: limits.dailyMcpCalls,
      mcpRpmLimit: limits.rpm,
      singleCallTokenCap: limits.tokenCap,
    },
    { label: 'user-tier-defaults' }
  );
}

/**
 * 仓数上限校验：开源版无限制，全员放行。
 */
export async function checkRepoLimit(
  _userId: string,
  _opts: {
    role?: string | null;
    tier?: string | null;
    /** 正在导入的目标仓（已保存则不计入新额度消耗） */
    targetRepo?: { owner: string; repo: string };
  } = {}
): Promise<{ allowed: true } | { allowed: false; limit: number; current: number }> {
  return { allowed: true };
}

/** 仓数超限的统一响应构造（scout/ingest 预检共用兜底） */
export function repoLimitErrorResponse(userId: string, denied: { limit: number; current: number }) {
  return {
    error: `仓库数量已达到上限 ${denied.limit} 个。`,
    code: 'TIER_REPO_LIMIT' as const,
    limit: denied.limit,
    current: denied.current,
    userId,
  };
}
