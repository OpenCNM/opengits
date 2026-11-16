import { test, expect } from 'vitest';
import { computeRecommendationScore, type RecommendationInput } from '@/lib/recommendation/score';
import { ENGINE_CONFIG } from '@/lib/config';

const R = ENGINE_CONFIG.recommendation;

function repoInput(overrides: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    savedCount: 0,
    mcpCallCount: 0,
    updatedAt: new Date(),
    reviewPipelineTotal: null,
    reviewLlmScore: null,
    ...overrides,
  };
}

test('全新仓（零信号）= 中性内容基线 + 满新鲜度', () => {
  const fresh = computeRecommendationScore(repoInput());
  expect(fresh.total).toBe(R.legacyNeutralBaseline + R.freshnessMax);
});

test('社区认可：5 保存即满分，封顶不溢出', () => {
  expect(computeRecommendationScore(repoInput({ savedCount: 5 })).breakdown.community).toBe(R.communityMax);
  expect(computeRecommendationScore(repoInput({ savedCount: 10 })).breakdown.community).toBe(R.communityMax);
});

test('MCP 价值：双满分；高盲区率惩罚封顶', () => {
  const full = computeRecommendationScore(repoInput({ mcpCallCount: 25 }), { recentCalls: 12, blindRate: 0 });
  expect(full.breakdown.mcpValue).toBe(R.mcpLifetimeMax + R.mcpRecentMax);
  const blindy = computeRecommendationScore(repoInput({ mcpCallCount: 25 }), { recentCalls: 12, blindRate: 0.8 });
  expect(blindy.breakdown.mcpValue).toBe(R.mcpLifetimeMax + R.mcpRecentMax - R.blindPenaltyMax);
});

test('内容基线：审核分高于存量中性', () => {
  const reviewed = computeRecommendationScore(repoInput({ reviewPipelineTotal: 90, reviewLlmScore: 88 }));
  const legacy = computeRecommendationScore(repoInput());
  expect(reviewed.breakdown.contentBaseline).toBeGreaterThan(legacy.breakdown.contentBaseline);
});

test('新鲜度：窗口内满分 → 中点减半 → 过期归零', () => {
  const age = (days: number) => new Date(Date.now() - days * 24 * 3600 * 1000);
  const fresh = computeRecommendationScore(repoInput({ updatedAt: age(89) })).breakdown.freshness;
  const mid = computeRecommendationScore(repoInput({ updatedAt: age((R.freshWindowDays + R.staleWindowDays) / 2) })).breakdown.freshness;
  const stale = computeRecommendationScore(repoInput({ updatedAt: age(R.staleWindowDays + 10) })).breakdown.freshness;
  expect(fresh).toBe(R.freshnessMax);
  expect(mid).toBeGreaterThan(0);
  expect(mid).toBeLessThan(R.freshnessMax);
  expect(stale).toBe(0);
});

test('排序语义：认可信号仓压过零信号仓（views 不参与打分）', () => {
  const quality = computeRecommendationScore(repoInput({ savedCount: 4, mcpCallCount: 30 }));
  const vanity = computeRecommendationScore(repoInput());
  expect(quality.total).toBeGreaterThan(vanity.total);
});
