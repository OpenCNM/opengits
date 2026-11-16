import { describe, expect, it } from 'vitest';
import { deriveUnitEconomics } from '@/lib/review/unit-economics';

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
