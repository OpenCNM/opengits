import { NextResponse } from 'next/server';
import { getSessionHelper } from '@/lib/auth-helper';
import { getDailyCreditsUsage, getResetWindowBounds } from '@/lib/credits-ledger';
import { getDynamicCreditsConfig, CREDITS_CONFIG } from '@/lib/credits-config';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { captureError } from '@/lib/observability/errors';

export const dynamic = 'force-dynamic';

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
