import { prisma } from '@/lib/db';
import { getDynamicCreditsConfig } from '@/lib/credits-config';
import { tierLimitsOf, isAdminRole } from '@/lib/tier-limits';

export interface UserCreditsUsage {
  dailyLimit: number;
  usedCredits: number;
  frozenCredits: number;
  /** 本窗口内章节贡献获赠（信息展示；入账于持久余额 creditBalance） */
  /** 贡献余额（持久钱包）：章节更新过门即入账，与每日配额独立、可跨日累积 */
  creditBalance: number;
  availableCredits: number;
  isUnlimited: boolean;
  maxPerImport: number;
  resetIntervalHours: number;
  nextResetAt: string;
}

/**
 * 获取在指定时间点与重置周期（默认 24h）下的窗口范围及下次重置时刻
 */
export function getResetWindowBounds(
  date = new Date(),
  intervalHours = 24
): { start: Date; end: Date; nextResetAt: Date } {
  const safeHours = Math.max(1, Math.floor(intervalHours || 24));
  const intervalMs = safeHours * 60 * 60 * 1000;
  const nowMs = date.getTime();
  const startMs = Math.floor(nowMs / intervalMs) * intervalMs;
  const nextResetMs = startMs + intervalMs;
  return {
    start: new Date(startMs),
    end: new Date(nextResetMs - 1),
    nextResetAt: new Date(nextResetMs),
  };
}


/**
 * 查询用户当前周期的算力积分使用情况（包含已消耗与在途冻结）
 */
export async function getDailyCreditsUsage(userId: string, targetDate = new Date()): Promise<UserCreditsUsage> {
  const config = await getDynamicCreditsConfig();
  if (!userId) {
    const { nextResetAt } = getResetWindowBounds(targetDate, config.resetIntervalHours);
    return {
      dailyLimit: config.defaultDailyCredits,
      usedCredits: 0,
      frozenCredits: 0,
        creditBalance: 0,
      availableCredits: 0,
      isUnlimited: false,
      maxPerImport: config.maxCreditsPerImport,
      resetIntervalHours: config.resetIntervalHours,
      nextResetAt: nextResetAt.toISOString(),
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, tier: true, creditBalance: true },
  });

  const isUnlimited = isAdminRole(user?.role) || user?.tier === 'ENTERPRISE';
  const limits = tierLimitsOf(user?.tier);
  const dailyLimit = isUnlimited ? 0 : (limits.dailyImportCredits || config.defaultDailyCredits);
  const maxPerImport = isUnlimited ? 0 : (limits.maxImportCreditsPerJob || config.maxCreditsPerImport);
  const { start, nextResetAt } = getResetWindowBounds(targetDate, config.resetIntervalHours);

  if (isUnlimited) {
    return {
      dailyLimit: 0,
      usedCredits: 0,
      frozenCredits: 0,
        creditBalance: user?.creditBalance ?? 0,
      availableCredits: 999999,
      isUnlimited: true,
      maxPerImport: 0,
      resetIntervalHours: config.resetIntervalHours,
      nextResetAt: nextResetAt.toISOString(),
    };
  }

  // 导入全面 0 消耗：usedCredits 与 frozenCredits 恒为 0，真实可用积分即为钱包余额 creditBalance
  const creditBalance = user?.creditBalance ?? 0;
  const usedCredits = 0;
  const frozenCredits = 0;
  const availableCredits = creditBalance;

  return {
    dailyLimit,
    usedCredits,
    frozenCredits,
    creditBalance,
    availableCredits,
    isUnlimited: false,
    maxPerImport,
    resetIntervalHours: config.resetIntervalHours,
    nextResetAt: nextResetAt.toISOString(),
  };
}

/**
 * 校验单次导入上限与可用余额
 * 导入转录全面 0 消耗，恒定允许通行，不再拦截 403 DAILY_QUOTA_EXCEEDED 或 EXCEEDS_SINGLE_LIMIT
 */
export async function validateImportCredits(
  userId: string,
  _requiredCredits?: number
): Promise<{ allowed: true; usage: UserCreditsUsage }> {
  const usage = await getDailyCreditsUsage(userId);
  return { allowed: true, usage };
}
