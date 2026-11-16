// 导入计费口径（credits/import-billing）单测：结算口径、code_pedagogy 判定统一（B2）。
// 入场估算族（estimateImportBilling/billableDocCountFromOutline）随提交期积分准入
// 退役删除（2026-11 收口）——估算相关历史用例一并移除，结算口径保留锁定。

import { test, expect } from 'vitest';
import {
  isCodePedagogyBilling,
  settleImportBilling,
} from '@/lib/credits/import-billing';
import { CREDITS_CONFIG } from '@/lib/credits-config';

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
