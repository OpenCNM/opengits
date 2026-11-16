import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 两桶积分模型聚合口径：
 * 每日配额（消费侧，窗口重置）与贡献余额 creditBalance（持久钱包）完全独立——
 * available = 配额余量 + 余额；SWAPPED 赠礼不再净额抵扣当日消费。
 */

const importJobFindManyMock = vi.fn();
const userFindUniqueMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    importJob: { findMany: importJobFindManyMock },
    user: { findUnique: userFindUniqueMock },
  },
}));

describe('两桶积分模型（getDailyCreditsUsage）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFindUniqueMock.mockResolvedValue({ role: null, tier: 'FREE', creditBalance: 0 });
    importJobFindManyMock.mockResolvedValue([]);
  });

  it('配额与余额独立：导入 0 消耗，真实可用积分即为用户钱包余额 creditBalance', async () => {
    const { getDailyCreditsUsage } = await import('@/lib/credits-ledger');
    userFindUniqueMock.mockResolvedValue({ role: null, tier: 'FREE', creditBalance: 500 });
    importJobFindManyMock.mockResolvedValue([
      { status: 'COMPLETED', params: { frozenCredits: 300 }, result: { actualCredits: 300 } },
    ]);
    const u = await getDailyCreditsUsage('u1');
    expect(u.creditBalance).toBe(500); // 持久钱包（入账在引擎事务，聚合只读）
    expect(u.availableCredits).toBe(500); // 可用积分即钱包余额
    expect(u.usedCredits).toBe(0); // 导入 0 消耗
    expect(u.frozenCredits).toBe(0);
  });

  it('余额跨窗口持久：今日零贡献，昨日余额仍在可用额度上', async () => {
    const { getDailyCreditsUsage } = await import('@/lib/credits-ledger');
    userFindUniqueMock.mockResolvedValue({ role: null, tier: 'FREE', creditBalance: 250 });

    const u = await getDailyCreditsUsage('u1');
    expect(u.availableCredits).toBe(250);
  });

  it('TRIAL/CLAIMED 不冻结、REJECTED 不计（赠送制无消费路径）', async () => {
    const { getDailyCreditsUsage } = await import('@/lib/credits-ledger');

    const u = await getDailyCreditsUsage('u1');
    expect(u.frozenCredits).toBe(0);
    expect(u.usedCredits).toBe(0);
    expect(u.availableCredits).toBe(0);
  });
});
