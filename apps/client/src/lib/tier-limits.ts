/**
 * ─────────────────────────────────────────────────────────────
 * 用户配额与权限等级注册表（集中配置，禁散落硬编码）
 *
 * 本文件是纯注册表（零服务端依赖，客户端组件可安全 import）；
 * 需要 prisma 的执行逻辑（applyTierDefaults / checkRepoLimit 等）
 * 在 src/lib/tiers.ts 中，后者 re-export 本文件的活跃导出保持兼容。
 *
 * 语义：
 * - `maxRepos`：运行时硬限制（0 = 不限）
 * - `dailyMcpCalls` / `rpm` / `tokenCap`：tier 变更时写入 User 对应
 *   字段（管理员可逐用户覆盖，运行时优先读 User 字段）
 * - ADMIN/SUPER_ADMIN 一律 bypass（限流器另有 600/0/32000 管理覆盖）
 * ─────────────────────────────────────────────────────────────
 */

type UserTier = 'FREE' | 'PRO' | 'ENTERPRISE';
export type PlanTier = UserTier; // 别名兼容（admin 经 tiers barrel 消费）

interface TierLimit {
  /** 个人书架仓数上限（0 = 不限） */
  maxRepos: number;
  /** MCP 工具调用每日配额默认值（0 = 不限） */
  dailyMcpCalls: number;
  /** 网关 RPM 限制默认值 */
  rpm: number;
  /** 单次响应 token 上限默认值 */
  tokenCap: number;
  /** 每日导入知识算力积分配额（0 = 不限） */
  dailyImportCredits: number;
  /** 单次导入最大允许消耗积分（0 = 不限） */
  maxImportCreditsPerJob: number;
  /** 展示名（仪表盘） */
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

/** 权限等级序（越高权限越大；用于工具级 tierRequirement 门禁比较，仅本文件消费） */
const TIER_RANK: Record<string, number> = { FREE: 0, PRO: 1, ENTERPRISE: 2 };

/** 工具级门禁：用户权限是否满足工具要求（admin 豁免；未知等级按 FREE 处理） */
export function meetsTierRequirement(
  userTier: string | null | undefined,
  requiredTier: string | null | undefined,
  isAdmin = false
): boolean {
  if (isAdmin) return true;
  const required = requiredTier ?? 'FREE';
  if (!(required in TIER_RANK)) return true; // 未知要求值不拦截（配置容错）
  return (TIER_RANK[userTier ?? 'FREE'] ?? 0) >= TIER_RANK[required];
}
