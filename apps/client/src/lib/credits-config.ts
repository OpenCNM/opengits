/**
 * ─────────────────────────────────────────────────────────────
 * 统一知识算力积分配置中心（集中注册表与动态热调中枢）
 * ─────────────────────────────────────────────────────────────
 */

export const CREDITS_CONFIG = {
  /** [DEPRECATED] 每日免费极客配额（导入转录现已全面 0 消耗，本配置已退役保留兼容） */
  DEFAULT_DAILY_CREDITS: 1000,

  /** [DEPRECATED] 额度重置周期（小时，本配置已退役保留兼容） */
  DEFAULT_RESET_INTERVAL_HOURS: 24,

  /** 单任务最高奖励防爆上限（唯一防刷维度：无每日累计额度，所有用户同上限） */
  MAX_CREDITS_PER_IMPORT: 300,

  /** 1 积分对应的标准切片字符基准（~1500 字符 ≈ 1 Chunk ≈ 1 积分） */
  STANDARD_CHUNK_CHAR_SIZE: 1500,

  /** 深度代码重构教学（Code Pedagogy）的算力倍率系数 */
  CODE_PEDAGOGY_MULTIPLIER: 2.0,

  /** Web 官方文档爬虫单次最大抓取页数（防爬虫死循环） */
  WEB_DOC_MAX_PAGES: 200,

  /** 发布赠送开关（Go settle.go grantPublishGift 真身门控；默认退役防双重补偿，
   *  admin API 写 true 即恢复——非死开关） */
  PUBLISH_GIFT_ENABLED: false,

  /** 书架计费系数：加入公开教程费用 = 劳动账本 × 本系数（1.0 等额；0 免费期） */
  SHELF_FEE_MULTIPLIER: 1.0,
  /** 一次性开户礼金：新注册自动领取，未领取的存量用户可补发 */
  SIGNUP_GIFT_CREDITS: 30,

  /** 贡献积分归属锁定期（天）：公开后剩余未结积分的锁定天数，admin 热调 */
  CONTRIBUTION_VESTING_DAYS: 7,
  /** 公开即时奖励比例：公开瞬间直接入账 User.creditBalance 的比例（0.0 ~ 1.0），admin 热调 */
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

/** 手动使内存缓存失效（Admin 保存后立即调用） */
export function invalidateCreditsConfigCache(): void {
  cachedConfig = null;
  cacheExpiresAt = 0;
}

/**
 * 获取全站当前生效的动态积分配置（带 10s 内存微缓存与 DB 降级）
 */
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
    // 数据库未就绪或表未同步时优雅降级
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

/**
 * 导入免费；奖励预估按篇数及字符数折算并封顶，不替代发布时按真实正文结算。
 */
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

  // 按字符数折算 Chunk，以文档篇数为天然保底下限（每篇至少 1 Chunk）
  const charBasedChunks = Math.ceil(chars / (chunkCharSize || 1500));
  const estimatedChunks = Math.max(docCount, charBasedChunks);

  const multiplier = params.isCodePedagogy ? pedagogyMultiplier : 1.0;
  const baseCredits = Math.ceil(estimatedChunks * multiplier);

  // 导入转录全面 0 消耗
  const finalCredits = 0;
  // 公开导入按篇幅/字符全额奖励，私有为 0
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
