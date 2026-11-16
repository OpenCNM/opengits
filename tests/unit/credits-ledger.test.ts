import { test, expect, describe, vi, beforeEach } from 'vitest';
import { CREDITS_CONFIG, estimateRequiredCredits } from '@/lib/credits-config';
import { getDailyCreditsUsage, validateImportCredits } from '@/lib/credits-ledger';
import { TIER_LIMITS } from '@/lib/tier-limits';

const userFindUniqueMock = vi.fn();
const chapterUpdateJobFindManyMock = vi.fn();
const creditGrantLedgerAggregateMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: (...args: unknown[]) => userFindUniqueMock(...args) },
    chapterUpdateJob: { findMany: (...args: unknown[]) => chapterUpdateJobFindManyMock(...args) },
    creditGrantLedger: { aggregate: (...args: unknown[]) => creditGrantLedgerAggregateMock(...args) },
  },
}));

describe('credits-config 知识算力积分预估与规则测试', () => {
  test('常数定义合规：每日1000配额、单次300防爆、公开默认-1.0奖励、Web抓取200页', () => {
    expect(CREDITS_CONFIG.DEFAULT_DAILY_CREDITS).toBe(1000);
    expect(CREDITS_CONFIG.MAX_CREDITS_PER_IMPORT).toBe(300);
      expect(CREDITS_CONFIG.STANDARD_CHUNK_CHAR_SIZE).toBe(1500);
    expect(CREDITS_CONFIG.CODE_PEDAGOGY_MULTIPLIER).toBe(2.0);
    expect(CREDITS_CONFIG.WEB_DOC_MAX_PAGES).toBe(200);
  });

  test('estimateRequiredCredits：基础按篇与切片预估', () => {
    // 10 篇短文档（共 6,000 字符），每篇至少保底 1 Chunk → 10 Chunks
    const res1 = estimateRequiredCredits({
      docCount: 10,
      totalChars: 6000,
      isPublic: false,
    });
    expect(res1.estimatedChunks).toBe(10);
    expect(res1.baseCredits).toBe(10);
    expect(res1.finalCredits).toBe(0);
    expect(res1.rewardCredits).toBe(0);
    expect(res1.discountApplied).toBe(false);

    // 10 篇万字长文档（共 150,000 字符）→ 100 Chunks
    const res2 = estimateRequiredCredits({
      docCount: 10,
      totalChars: 150000,
      isPublic: false,
    });
    expect(res2.estimatedChunks).toBe(100);
    expect(res2.baseCredits).toBe(100);
    expect(res2.finalCredits).toBe(0);
    expect(res2.rewardCredits).toBe(0);
  });

  test('estimateRequiredCredits：公开导入默认 0 消耗且全额体量奖励（-1.0x）', () => {
    const res = estimateRequiredCredits({
      docCount: 50,
      totalChars: 75000, // 50 chunks
      isPublic: true,
    });
    expect(res.baseCredits).toBe(50);
    expect(res.finalCredits).toBe(0);
    expect(res.rewardCredits).toBe(50); // 50 * 1.0 = 50
    expect(res.discountApplied).toBe(true);
  });

  test('estimateRequiredCredits：公开导入免消耗与按体量发放奖励', () => {
    // 公开导入（0 消耗，全额奖励）
    const resPublic = estimateRequiredCredits(
      { docCount: 20, totalChars: 30000, isPublic: true }
    );
    expect(resPublic.baseCredits).toBe(20);
    expect(resPublic.finalCredits).toBe(0);
    expect(resPublic.rewardCredits).toBe(20);

    // 私有导入（0 消耗，0 奖励）
    const resPrivate = estimateRequiredCredits(
      { docCount: 20, totalChars: 30000, isPublic: false }
    );
    expect(resPrivate.baseCredits).toBe(20);
    expect(resPrivate.finalCredits).toBe(0);
    expect(resPrivate.rewardCredits).toBe(0);
  });

  test('estimateRequiredCredits：深度代码教学模式加权 2.0x', () => {
    // 私有代码教学（0 消耗，0 奖励，计算 baseCredits 考虑倍率）
    const resPrivate = estimateRequiredCredits({
      docCount: 20,
      totalChars: 30000,
      isPublic: false,
      isCodePedagogy: true,
    });
    expect(resPrivate.baseCredits).toBe(40); // 20 * 2.0 = 40
    expect(resPrivate.finalCredits).toBe(0);
    expect(resPrivate.rewardCredits).toBe(0);

    // 公开代码教学 (2.0x 乘数 与 默认 -1.0 奖励叠加：0 消耗 + 40 奖励)
    const resPublic = estimateRequiredCredits({
      docCount: 20,
      totalChars: 30000,
      isPublic: true,
      isCodePedagogy: true,
    });
    expect(resPublic.baseCredits).toBe(40);
    expect(resPublic.finalCredits).toBe(0);
    expect(resPublic.rewardCredits).toBe(40);
  });

  test('TIER_LIMITS 配额积分字段同步完整', () => {
    expect(TIER_LIMITS.FREE.dailyImportCredits).toBe(1000);
    expect(TIER_LIMITS.FREE.maxImportCreditsPerJob).toBe(300);

    expect(TIER_LIMITS.PRO.dailyImportCredits).toBe(3000);
    expect(TIER_LIMITS.PRO.maxImportCreditsPerJob).toBe(600);

    expect(TIER_LIMITS.ENTERPRISE.dailyImportCredits).toBe(0);
    expect(TIER_LIMITS.ENTERPRISE.maxImportCreditsPerJob).toBe(0);
  });

});

describe('getDailyCreditsUsage & validateImportCredits 导入全面 0 消耗业务守卫', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chapterUpdateJobFindManyMock.mockResolvedValue([]);
    creditGrantLedgerAggregateMock.mockResolvedValue({ _sum: { amount: 0 } });
  });

  test('getDailyCreditsUsage：导入全面 0 消耗，usedCredits 与 frozenCredits 恒为 0，availableCredits 等于钱包余额', async () => {
    userFindUniqueMock.mockResolvedValueOnce({
      role: 'USER',
      tier: 'FREE',
      creditBalance: 150,
    });

    const usage = await getDailyCreditsUsage('user-1');
    expect(usage.usedCredits).toBe(0);
    expect(usage.frozenCredits).toBe(0);
    expect(usage.creditBalance).toBe(150);
    expect(usage.availableCredits).toBe(150);
    expect(usage.isUnlimited).toBe(false);
  });

  test('getDailyCreditsUsage：企业级或管理员用户 isUnlimited 为 true', async () => {
    userFindUniqueMock.mockResolvedValueOnce({
      role: 'ADMIN',
      tier: 'FREE',
      creditBalance: 888,
    });

    const usage = await getDailyCreditsUsage('admin-1');
    expect(usage.isUnlimited).toBe(true);
    expect(usage.availableCredits).toBe(999999);
    expect(usage.creditBalance).toBe(888);
  });

  test('getDailyCreditsUsage：空 userId 防御回退，不抛异常', async () => {
    const usage = await getDailyCreditsUsage('');
    expect(usage.availableCredits).toBe(0);
    expect(usage.creditBalance).toBe(0);
    expect(usage.usedCredits).toBe(0);
    expect(usage.frozenCredits).toBe(0);
    expect(userFindUniqueMock).not.toHaveBeenCalled();
  });

  test('validateImportCredits：恒定返回 allowed: true，无论请求额度或当前余额如何', async () => {
    userFindUniqueMock.mockResolvedValueOnce({
      role: 'USER',
      tier: 'FREE',
      creditBalance: 0, // 0 余额
    });

    const result = await validateImportCredits('user-zero-balance', 9999);
    expect(result.allowed).toBe(true);
    expect(result.usage.availableCredits).toBe(0);
    expect(result.usage.usedCredits).toBe(0);
    expect(result.usage.frozenCredits).toBe(0);
  });
});
