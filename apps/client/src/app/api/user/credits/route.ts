import { NextResponse } from 'next/server';
import { getSessionHelper } from '@/lib/auth-helper';
import { getDailyCreditsUsage, getResetWindowBounds } from '@/lib/credits-ledger';
import { getDynamicCreditsConfig, CREDITS_CONFIG } from '@/lib/credits-config';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { captureError } from '@/lib/observability/errors';

export const dynamic = 'force-dynamic';

/** 匿名/降级态的默认配额视图（未登录或配置读取失败时返回，保持 200 语义） */
function fallbackCreditsPayload(config: {
  defaultDailyCredits: number;
  maxCreditsPerImport: number;
  resetIntervalHours: number;
}) {
  const { nextResetAt } = getResetWindowBounds(new Date(), config.resetIntervalHours);
  return {
    loggedIn: false,
    dailyLimit: config.defaultDailyCredits,
    usedCredits: 0,
    frozenCredits: 0,
    creditBalance: 0,
    availableCredits: config.defaultDailyCredits,
    isUnlimited: false,
    maxPerImport: config.maxCreditsPerImport,
    resetIntervalHours: config.resetIntervalHours,
    nextResetAt: nextResetAt.toISOString(),
  };
}

/**
 * GET /api/user/credits —— 当前积分余额与用量（配额弹窗数据源）。
 * 匿名可访问（返回未登录默认视图）；配置/账本异常时优雅降级为默认视图，
 * 因此这里不走 defineRoute 的统一 500 通道，降级分支用 NextResponse 透传。
 */
export const GET = defineRoute({
  scope: 'GET /api/user/credits',
  auth: 'public',
  handler: async () => {
    try {
      const config = await getDynamicCreditsConfig();
      const session = await getSessionHelper();
      if (!session?.user?.id) {
        return ok(fallbackCreditsPayload(config));
      }

      const usage = await getDailyCreditsUsage(session.user.id);
      return ok({
        loggedIn: true,
        ...usage,
      });
    } catch (error) {
      await captureError(error, { scope: 'GET /api/user/credits' });
      return NextResponse.json({
        success: true as const,
        data: fallbackCreditsPayload({
          defaultDailyCredits: CREDITS_CONFIG.DEFAULT_DAILY_CREDITS,
          maxCreditsPerImport: CREDITS_CONFIG.MAX_CREDITS_PER_IMPORT,
          resetIntervalHours: CREDITS_CONFIG.DEFAULT_RESET_INTERVAL_HOURS,
        }),
      });
    }
  },
});
