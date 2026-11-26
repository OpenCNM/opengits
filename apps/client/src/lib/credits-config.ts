import { ignoreBestEffort } from '@/lib/best-effort';

export const CREDITS_CONFIG = {
  DEFAULT_DAILY_CREDITS: 1000,

  DEFAULT_RESET_INTERVAL_HOURS: 24,

  MAX_CREDITS_PER_IMPORT: 300,

  STANDARD_CHUNK_CHAR_SIZE: 1500,

  CODE_PEDAGOGY_MULTIPLIER: 2.0,

  WEB_DOC_MAX_PAGES: 200,

  PUBLISH_GIFT_ENABLED: false,

  SHELF_FEE_MULTIPLIER: 1.0,
  SIGNUP_GIFT_CREDITS: 30,

  CONTRIBUTION_VESTING_DAYS: 7,
  INITIAL_PUBLISH_REWARD_RATIO: 0.0,
} as const;

export interface DynamicCreditsConfig {
  defaultDailyCredits: number;
  resetIntervalHours: number;
  maxCreditsPerImport: number;
  codePedagogyMultiplier: number;
  standardChunkCharSize: number;
  webDocMaxPages: number;
  publishGiftEnabled: boolean;
  shelfFeeMultiplier: number;
  contributionVestingDays: number;
  initialPublishRewardRatio: number;
}

let cachedConfig: DynamicCreditsConfig | null = null;
let cacheExpiresAt = 0;

export function invalidateCreditsConfigCache(): void {
  cachedConfig = null;
  cacheExpiresAt = 0;
}

export async function getDynamicCreditsConfig(): Promise<DynamicCreditsConfig> {
  const now = Date.now();
  if (cachedConfig && now < cacheExpiresAt) {
    return cachedConfig;
  }

  try {
    const { prisma } = await import('@/lib/db');
    const row = await prisma.platformCreditsConfig.findUnique({
      where: { id: 'singleton' },
    });

    if (row) {
      cachedConfig = {
        defaultDailyCredits: typeof row.defaultDailyCredits === 'number' ? row.defaultDailyCredits : CREDITS_CONFIG.DEFAULT_DAILY_CREDITS,
        resetIntervalHours: typeof row.resetIntervalHours === 'number' && row.resetIntervalHours > 0 ? row.resetIntervalHours : CREDITS_CONFIG.DEFAULT_RESET_INTERVAL_HOURS,
        maxCreditsPerImport: typeof row.maxCreditsPerImport === 'number' ? row.maxCreditsPerImport : CREDITS_CONFIG.MAX_CREDITS_PER_IMPORT,
        codePedagogyMultiplier: typeof row.codePedagogyMultiplier === 'number' ? row.codePedagogyMultiplier : CREDITS_CONFIG.CODE_PEDAGOGY_MULTIPLIER,
        standardChunkCharSize: typeof row.standardChunkCharSize === 'number' ? row.standardChunkCharSize : CREDITS_CONFIG.STANDARD_CHUNK_CHAR_SIZE,
        webDocMaxPages: CREDITS_CONFIG.WEB_DOC_MAX_PAGES,
        publishGiftEnabled: typeof row.publishGiftEnabled === 'boolean' ? row.publishGiftEnabled : CREDITS_CONFIG.PUBLISH_GIFT_ENABLED,
        shelfFeeMultiplier: typeof row.shelfFeeMultiplier === 'number' && row.shelfFeeMultiplier >= 0 ? row.shelfFeeMultiplier : CREDITS_CONFIG.SHELF_FEE_MULTIPLIER,
        contributionVestingDays: typeof row.contributionVestingDays === 'number' && row.contributionVestingDays > 0 ? row.contributionVestingDays : CREDITS_CONFIG.CONTRIBUTION_VESTING_DAYS,
        initialPublishRewardRatio: typeof row.initialPublishRewardRatio === 'number' && row.initialPublishRewardRatio >= 0 && row.initialPublishRewardRatio <= 1 ? row.initialPublishRewardRatio : CREDITS_CONFIG.INITIAL_PUBLISH_REWARD_RATIO,
      };
      cacheExpiresAt = now + 10_000;
      return cachedConfig;
    }
  } catch {
    ignoreBestEffort();
  }

  return {
    defaultDailyCredits: CREDITS_CONFIG.DEFAULT_DAILY_CREDITS,
    resetIntervalHours: CREDITS_CONFIG.DEFAULT_RESET_INTERVAL_HOURS,
    maxCreditsPerImport: CREDITS_CONFIG.MAX_CREDITS_PER_IMPORT,
    codePedagogyMultiplier: CREDITS_CONFIG.CODE_PEDAGOGY_MULTIPLIER,
    standardChunkCharSize: CREDITS_CONFIG.STANDARD_CHUNK_CHAR_SIZE,
    webDocMaxPages: CREDITS_CONFIG.WEB_DOC_MAX_PAGES,
    publishGiftEnabled: CREDITS_CONFIG.PUBLISH_GIFT_ENABLED,
    shelfFeeMultiplier: CREDITS_CONFIG.SHELF_FEE_MULTIPLIER,
    contributionVestingDays: CREDITS_CONFIG.CONTRIBUTION_VESTING_DAYS,
    initialPublishRewardRatio: CREDITS_CONFIG.INITIAL_PUBLISH_REWARD_RATIO,
  };
}

interface EstimateRequiredCreditsResult {
  estimatedChunks: number;
  baseCredits: number;
  finalCredits: number;
  rewardCredits: number;
  discountApplied: boolean;
}

export function estimateRequiredCredits(
  params: {
    totalChars?: number;
    docCount?: number;
    isPublic?: boolean;
    isCodePedagogy?: boolean;
  },
  config?: Partial<DynamicCreditsConfig>
): EstimateRequiredCreditsResult {
  const chars = Math.max(0, params.totalChars || 0);
  const docCount = Math.max(1, params.docCount || 1);
  const chunkCharSize = config?.standardChunkCharSize ?? CREDITS_CONFIG.STANDARD_CHUNK_CHAR_SIZE;
  const pedagogyMultiplier = config?.codePedagogyMultiplier ?? CREDITS_CONFIG.CODE_PEDAGOGY_MULTIPLIER;

  const charBasedChunks = Math.ceil(chars / (chunkCharSize || 1500));
  const estimatedChunks = Math.max(docCount, charBasedChunks);

  const multiplier = params.isCodePedagogy ? pedagogyMultiplier : 1.0;
  const baseCredits = Math.ceil(estimatedChunks * multiplier);

  const finalCredits = 0;
  const rewardLimit = Math.max(0, config?.maxCreditsPerImport ?? CREDITS_CONFIG.MAX_CREDITS_PER_IMPORT);
  const rewardCredits = params.isPublic ? Math.min(baseCredits, rewardLimit) : 0;

  return {
    estimatedChunks,
    baseCredits,
    finalCredits,
    rewardCredits,
    discountApplied: !!params.isPublic,
  };
}
