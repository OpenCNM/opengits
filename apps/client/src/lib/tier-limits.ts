type UserTier = 'FREE' | 'PRO' | 'ENTERPRISE';
export type PlanTier = UserTier;

interface TierLimit {
  maxRepos: number;
  dailyMcpCalls: number;
  rpm: number;
  tokenCap: number;
  dailyImportCredits: number;
  maxImportCreditsPerJob: number;
  label: string;
}

export const TIER_LIMITS: Record<UserTier, TierLimit> = {
  FREE: {
    maxRepos: 3,
    dailyMcpCalls: 100,
    rpm: 30,
    tokenCap: 4000,
    dailyImportCredits: 1000,
    maxImportCreditsPerJob: 300,
    label: 'Free',
  },
  PRO: {
    maxRepos: 100,
    dailyMcpCalls: 3000,
    rpm: 120,
    tokenCap: 8000,
    dailyImportCredits: 3000,
    maxImportCreditsPerJob: 600,
    label: 'Pro',
  },
  ENTERPRISE: {
    maxRepos: 0,
    dailyMcpCalls: 0,
    rpm: 600,
    tokenCap: 32000,
    dailyImportCredits: 0,
    maxImportCreditsPerJob: 0,
    label: 'Enterprise',
  },
};

const DEFAULT_TIER: UserTier = 'FREE';

const ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);

function isUserTier(value: string): value is UserTier {
  return value in TIER_LIMITS;
}
export const isPlanTier = isUserTier;

export function tierLimitsOf(tier: string | null | undefined): TierLimit {
  const t = tier && isUserTier(tier) ? tier : DEFAULT_TIER;
  return TIER_LIMITS[t];
}

export function isAdminRole(role: string | null | undefined): boolean {
  return !!role && ADMIN_ROLES.has(role);
}

const TIER_RANK: Record<string, number> = { FREE: 0, PRO: 1, ENTERPRISE: 2 };

export function meetsTierRequirement(
  userTier: string | null | undefined,
  requiredTier: string | null | undefined,
  isAdmin = false
): boolean {
  if (isAdmin) return true;
  const required = requiredTier ?? 'FREE';
  if (!(required in TIER_RANK)) return true;
  return (TIER_RANK[userTier ?? 'FREE'] ?? 0) >= TIER_RANK[required];
}
