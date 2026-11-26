import { test, expect, describe, it } from "vitest";
import { isCodePedagogyBilling, settleImportBilling } from "@/lib/credits/import-billing";
import { CREDITS_CONFIG } from "@/lib/credits-config";
import { deriveUnitEconomics } from "@/lib/review/unit-economics";

describe("import-billing", () => {
const baseConfig = {
  defaultDailyCredits: 1000,
  resetIntervalHours: 24,
  maxCreditsPerImport: 300,
  codePedagogyMultiplier: 2.0,
  standardChunkCharSize: CREDITS_CONFIG.STANDARD_CHUNK_CHAR_SIZE,
  webDocMaxPages: 200,
  webDocMaxDepth: 3,
  transcriptionEarnMultiplier: 1.0,
  transcriptionCharsPerCredit: 1500,
  transcriptionCreditMin: 2,
  transcriptionCreditMax: 30,
  transcriptionCodeMultiplier: 2.0,
  transcriptionBonusRate: 0.5,
  publishGiftEnabled: false,
  shelfFeeMultiplier: 1.0,
};

// ---------- B2：code_pedagogy 判定单一口径 ----------

test('isCodePedagogyBilling：teachingDepth 非 overview 或 code_only（结算共用）', () => {
  expect(isCodePedagogyBilling({ teachingDepth: 'deep' })).toBe(true);
  expect(isCodePedagogyBilling({ teachingDepth: 'standard' })).toBe(true);
  expect(isCodePedagogyBilling({ teachingDepth: 'overview' })).toBe(false);
  expect(isCodePedagogyBilling({ teachingDepth: null, ingestMode: 'code_only' })).toBe(true);
  expect(isCodePedagogyBilling({ teachingDepth: null, ingestMode: 'text_only' })).toBe(false);
  expect(isCodePedagogyBilling({})).toBe(false);
});

// ---------- 结算口径 ----------

test('结算统一口径：导入转录 0 消耗，真实字符数如实反映在 baseCredits 中', () => {
  const settled = settleImportBilling({
    actualDocCount: 80,
    actualChars: 120_000,
    isPublic: false,
    config: baseConfig,
  });
  expect(settled.finalCredits).toBe(0);
  expect(settled.baseCredits).toBe(80);
});

test('公开导入：结算 0 消耗且发放 100% 奖励积分', () => {
  const settled = settleImportBilling({
    actualDocCount: 25,
    actualChars: 37_500,
    isPublic: true,
    config: baseConfig,
  });
  expect(settled.baseCredits).toBe(25);
  expect(settled.finalCredits).toBe(0);
  expect(settled.rewardCredits).toBe(25);
  expect(settled.discountApplied).toBe(true);
});

test('实发只按真实字符计酬，所有用户同单任务上限且无日配额', () => {
  for (const actualDocCount of [1, 1000]) {
    expect(settleImportBilling({ actualDocCount, actualChars: 1501, isPublic: true, config: baseConfig }).rewardCredits).toBe(2);
    expect(settleImportBilling({ actualDocCount, isPublic: true, config: baseConfig }).rewardCredits).toBe(0);
  }
  expect(settleImportBilling({ actualDocCount: 1, actualChars: 1_500_000, isPublic: true, config: baseConfig }).rewardCredits).toBe(300);
  expect(settleImportBilling({ actualDocCount: 1, actualChars: 1_500_000, isPublic: false, config: baseConfig }).rewardCredits).toBe(0);
  const exhaustedLegacyQuota = { ...baseConfig, defaultDailyCredits: 0 };
  expect(settleImportBilling({ actualDocCount: 1, actualChars: 1501, isPublic: true, config: exhaustedLegacyQuota }).rewardCredits).toBe(2);
});
});

describe("unit-economics", () => {
describe('deriveUnitEconomics（单位经济纯函数推导）', () => {
  const repos = [
    {
      id: 'r1', owner: 'octo', repo: 'kit', edition: '', isPublic: true,
      views: 500, publishedAt: null, transcriptionTokens: 250_000, transcriptionCreditsEarned: 30,
    },
    {
      id: 'r2', owner: 'ada', repo: 'lib', edition: 'ed_deep', isPublic: false,
      views: 0, publishedAt: null, transcriptionTokens: 0, transcriptionCreditsEarned: 0,
    },
  ];

  const ledger = [
    { repositoryId: 'r1', source: 'IMPORT_REWARD', totalAmount: 100 },
    { repositoryId: 'r1', source: 'RETRANSLATE_REWARD', totalAmount: 50 },
  ];
  const pending = [
    { repositoryId: 'r1', status: 'PENDING', totalAmount: 40 },
    { repositoryId: 'r1', status: 'UNLOCKED', totalAmount: 60 },
    { repositoryId: 'r1', status: 'CANCELLED', totalAmount: 10 },
  ];
  const docs = [
    { repositoryId: 'r1', status: 'PROCESSED', count: 8 },
    { repositoryId: 'r1', status: 'UNPROCESSED', count: 2 },
  ];
  const followers = [{ repositoryId: 'r1', count: 7 }];
  const relay = [{ repositoryId: 'r1', totalActual: 25 }];

  it('按仓聚合：授予分桶 / 待解冻三态 / 章节 / 跟随 / 接力实结', () => {
    const { entries } = deriveUnitEconomics(repos, ledger, pending, docs, followers, relay);
    const r1 = entries.find((e) => e.id === 'r1')!;
    expect(r1.grantedBySource).toEqual({ IMPORT_REWARD: 100, RETRANSLATE_REWARD: 50 });
    expect(r1.grantedTotal).toBe(150);
    expect(r1.pendingLocked).toBe(40);
    expect(r1.pendingUnlocked).toBe(60);
    expect(r1.pendingCancelled).toBe(10);
    expect(r1.chaptersTotal).toBe(10);
    expect(r1.chaptersProcessed).toBe(8);
    expect(r1.followers).toBe(7);
    expect(r1.relayActualCredits).toBe(25);
  });

  it('效率指标：viewsPerMillionTokens 正确换算；零消耗/零浏览为 null（无语义即不编数）', () => {
    const { entries } = deriveUnitEconomics(repos, ledger, pending, docs, followers, relay);
    const r1 = entries.find((e) => e.id === 'r1')!;
    expect(r1.viewsPerMillionTokens).toBeCloseTo((500 / 250_000) * 1_000_000);
    // creditsPerKiloViews 分母含接力实结：(150 + 25) / 500 * 1000
    expect(r1.creditsPerKiloViews).toBeCloseTo(350);

    const r2 = entries.find((e) => e.id === 'r2')!;
    expect(r2.viewsPerMillionTokens).toBeNull();
    expect(r2.creditsPerKiloViews).toBeNull();
  });

  it('平台汇总与全量效率', () => {
    const { summary } = deriveUnitEconomics(repos, ledger, pending, docs, followers, relay);
    expect(summary.repoCount).toBe(2);
    expect(summary.totalTokens).toBe(250_000);
    expect(summary.totalGranted).toBe(150);
    expect(summary.totalPendingLocked).toBe(40);
    expect(summary.totalPendingUnlocked).toBe(60);
    expect(summary.totalRelayActualCredits).toBe(25);
    expect(summary.totalViews).toBe(500);
    expect(summary.viewsPerMillionTokens).toBeCloseTo((500 / 250_000) * 1_000_000);
  });

  it('缺失聚合组的仓安全归零（catch 兜底路径的空组输入）', () => {
    const { entries } = deriveUnitEconomics(repos, [], [], [], [], []);
    const r1 = entries.find((e) => e.id === 'r1')!;
    expect(r1.grantedTotal).toBe(0);
    expect(r1.pendingLocked).toBe(0);
    expect(r1.chaptersTotal).toBe(0);
    expect(r1.followers).toBe(0);
  });
});
});