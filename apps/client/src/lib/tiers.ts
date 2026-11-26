import { callSidecar } from '@/lib/sidecar-client';

export {
  TIER_LIMITS,
  isPlanTier,
  tierLimitsOf,
  isAdminRole,
  meetsTierRequirement,
} from '@/lib/tier-limits';
export type { PlanTier } from '@/lib/tier-limits';

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

export async function checkRepoLimit(
  _userId: string,
  _opts: {
    role?: string | null;
    tier?: string | null;
    targetRepo?: { owner: string; repo: string };
  } = {}
): Promise<{ allowed: true } | { allowed: false; limit: number; current: number }> {
  return { allowed: true };
}

export function repoLimitErrorResponse(userId: string, denied: { limit: number; current: number }) {
  return {
    error: `仓库数量已达到上限 ${denied.limit} 个。`,
    code: 'TIER_REPO_LIMIT' as const,
    limit: denied.limit,
    current: denied.current,
    userId,
  };
}
