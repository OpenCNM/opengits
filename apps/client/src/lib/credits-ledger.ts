import { prisma } from '@/lib/db';
import { getDynamicCreditsConfig } from '@/lib/credits-config';
import { tierLimitsOf, isAdminRole } from '@/lib/tier-limits';

export interface UserCreditsUsage {
  dailyLimit: number;
  usedCredits: number;
  frozenCredits: number;
  creditBalance: number;
  availableCredits: number;
  isUnlimited: boolean;
  maxPerImport: number;
  resetIntervalHours: number;
  nextResetAt: string;
}

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

export async function validateImportCredits(
  userId: string,
  _requiredCredits?: number
): Promise<{ allowed: true; usage: UserCreditsUsage }> {
  const usage = await getDailyCreditsUsage(userId);
  return { allowed: true, usage };
}
