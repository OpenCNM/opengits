import { beforeEach, describe, expect, it, vi } from 'vitest';

const savedRepoFindUniqueMock = vi.fn();
const savedRepoUpsertMock = vi.fn();
const savedRepoCreateMock = vi.fn();
const repoFindUniqueMock = vi.fn();
const repoUpdateMock = vi.fn();
const importRecordFindFirstMock = vi.fn();
const chapterUpdateJobFindFirstMock = vi.fn();
const chapterVersionFindFirstMock = vi.fn();
const userFindUniqueMock = vi.fn();
const userUpdateManyMock = vi.fn();
const userUpdateMock = vi.fn();
const queryRawMock = vi.fn();
const transactionMock = vi.fn();
const callSidecarMock = vi.fn();

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

vi.mock('@/lib/db', () => {
  const tx = {
    savedRepo: {
      findUnique: (...args: unknown[]) => savedRepoFindUniqueMock(...args),
      create: (...args: unknown[]) => savedRepoCreateMock(...args),
    },
    user: {
      findUnique: (...args: unknown[]) => userFindUniqueMock(...args),
      updateMany: (...args: unknown[]) => userUpdateManyMock(...args),
      update: (...args: unknown[]) => userUpdateMock(...args),
    },
    $queryRaw: (...args: unknown[]) => queryRawMock(...args),
  };
  return {
    prisma: {
      savedRepo: {
        findUnique: (...args: unknown[]) => savedRepoFindUniqueMock(...args),
        upsert: (...args: unknown[]) => savedRepoUpsertMock(...args),
        create: (...args: unknown[]) => savedRepoCreateMock(...args),
      },
      repository: {
        findUnique: (...args: unknown[]) => repoFindUniqueMock(...args),
        update: (...args: unknown[]) => repoUpdateMock(...args),
      },
      importRecord: {
        findFirst: (...args: unknown[]) => importRecordFindFirstMock(...args),
      },
      chapterUpdateJob: {
        findFirst: (...args: unknown[]) => chapterUpdateJobFindFirstMock(...args),
      },
      chapterVersion: {
        findFirst: (...args: unknown[]) => chapterVersionFindFirstMock(...args),
      },
      user: {
        findUnique: (...args: unknown[]) => userFindUniqueMock(...args),
        updateMany: (...args: unknown[]) => userUpdateManyMock(...args),
        update: (...args: unknown[]) => userUpdateMock(...args),
      },
      $transaction: (fn: (innerTx: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

vi.mock('@/lib/credits-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/credits-config')>();
  return {
    ...actual,
    getDynamicCreditsConfig: vi.fn().mockResolvedValue({
      defaultDailyCredits: actual.CREDITS_CONFIG.DEFAULT_DAILY_CREDITS,
      resetIntervalHours: actual.CREDITS_CONFIG.DEFAULT_RESET_INTERVAL_HOURS,
      maxCreditsPerImport: 300,
      codePedagogyMultiplier: 2.0,
      standardChunkCharSize: 1500,
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
    }),
  };
});

describe('M06 Credits: Shelf Fee and Gift Operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedRepoFindUniqueMock.mockResolvedValue(null);
    repoFindUniqueMock.mockResolvedValue({ isPublic: true, transcriptionCreditsEarned: 100 });
    importRecordFindFirstMock.mockResolvedValue(null);
    chapterUpdateJobFindFirstMock.mockResolvedValue(null);
    chapterVersionFindFirstMock.mockResolvedValue(null);
    userUpdateManyMock.mockResolvedValue({ count: 1 });
    userFindUniqueMock.mockResolvedValue({ creditBalance: 200 });
    queryRawMock.mockResolvedValue([]);
    callSidecarMock.mockImplementation(async (path: string, payload: { fee: number; autoFollow?: boolean }) => ({
      ok: true,
      fee: payload?.fee ?? 0,
      signupGift: 0,
      alreadySaved: false,
    }));
  });

  it('🧪 [6.1.1.1] 计费积分强制向上取整为整数（Math.ceil 防浮点碎屑）', async () => {
    const { computeShelfFee } = await import('@/lib/credits/shelf-fee');
    const { settleImportBilling } = await import('@/lib/credits/import-billing');
    const { getDynamicCreditsConfig } = await import('@/lib/credits-config');
    const config = await getDynamicCreditsConfig();

    // 1. 书架计费函数整数与取整校验
    const fee1 = computeShelfFee(9.999999, 1.0);
    expect(Number.isInteger(fee1)).toBe(true);
    expect(fee1).toBe(10);

    const fee2 = computeShelfFee(10.2, 1.5);
    expect(Number.isInteger(fee2)).toBe(true);
    expect(fee2).toBe(15);

    // 存量未记账教程（ledger <= 0）篇数保底
    expect(computeShelfFee(0, 1.0, 10)).toBe(5);
    expect(computeShelfFee(0, 1.0, 1)).toBe(1);
    expect(computeShelfFee(0, 1.0, 0)).toBe(0);
    expect(computeShelfFee(0, 0, 10)).toBe(0);
    expect(computeShelfFee(-5, 1.0, 10)).toBe(5);
    expect(computeShelfFee(20, 1.0, 10)).toBe(20);

    // 2. 结算积分强制 Math.ceil 向上取整，绝无浮点碎屑
    // 公开导入 0 消耗且全额体量奖励（-1.0x；入场估算已随提交期准入退役删除）
    const settled = settleImportBilling({
      actualDocCount: 7,
      isPublic: true,
      teachingDepth: 'deep',
      config,
    });
    expect(Number.isInteger(settled.baseCredits)).toBe(true);
    expect(Number.isInteger(settled.finalCredits)).toBe(true);
    expect(settled.finalCredits).toBe(0);
    expect(settled.rewardCredits).toBe(settled.baseCredits);

    // 私有导入验证 0 消耗与 0 奖励
    const settledPrivate = settleImportBilling({
      actualDocCount: 7,
      isPublic: false,
      teachingDepth: 'deep',
      config,
    });
    expect(settledPrivate.finalCredits).toBe(0);
    expect(settledPrivate.rewardCredits).toBe(0);
  });

  it('🧪 [6.1.2.1] 教程导入者与贡献者白名单收藏免扣费（fee = 0）', async () => {
    const { isShelfFeeExempt, chargeShelfFeeAndSave } = await import('@/lib/credits/shelf-fee');

    // 导入记录命中 -> 豁免
    importRecordFindFirstMock.mockResolvedValueOnce({ id: 'import-rec-1' });
    const exemptByImport = await isShelfFeeExempt('user-1', 'repo-1');
    expect(exemptByImport).toBe(true);

    // 市场贡献者命中 -> 豁免
    importRecordFindFirstMock.mockResolvedValueOnce(null);
    chapterUpdateJobFindFirstMock.mockResolvedValueOnce({ id: 'job-1' });
    const exemptByJob = await isShelfFeeExempt('user-2', 'repo-1');
    expect(exemptByJob).toBe(true);

    // 历史版本作者命中 -> 豁免
    importRecordFindFirstMock.mockResolvedValueOnce(null);
    chapterUpdateJobFindFirstMock.mockResolvedValueOnce(null);
    chapterVersionFindFirstMock.mockResolvedValueOnce({ id: 'ver-1' });
    const exemptByVersion = await isShelfFeeExempt('user-3', 'repo-1');
    expect(exemptByVersion).toBe(true);

    // 实际 chargeShelfFeeAndSave: 命中豁免时 fee 为 0，不扣减余额直接 upsert（委托 Go sidecar 单写者）
    importRecordFindFirstMock.mockResolvedValueOnce({ id: 'import-rec-1' });
    const res = await chargeShelfFeeAndSave('user-1', 'repo-1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.fee).toBe(0);
      expect(res.alreadySaved).toBe(false);
    }
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/credits/shelf-fee/charge',
      expect.objectContaining({ userId: 'user-1', repositoryId: 'repo-1', fee: 0 }),
      expect.anything()
    );

    // 幂等性断言：若已存在收藏记录（alreadySaved），立即返回已收藏，不重复扣费与写库
    callSidecarMock.mockResolvedValueOnce({ ok: true, alreadySaved: true, fee: 0, signupGift: 0 });
    const alreadyRes = await chargeShelfFeeAndSave('user-1', 'repo-1');
    expect(alreadyRes.ok).toBe(true);
    if (alreadyRes.ok) {
      expect(alreadyRes.alreadySaved).toBe(true);
      expect(alreadyRes.fee).toBe(0);
      expect(alreadyRes.signupGift).toBe(0);
    }

    // 私有仓库豁免断言：私有仓（isPublic: false）免费收藏
    savedRepoFindUniqueMock.mockResolvedValueOnce(null);
    repoFindUniqueMock.mockResolvedValueOnce({ isPublic: false, transcriptionCreditsEarned: 500 });
    const privateRes = await chargeShelfFeeAndSave('user-1', 'repo-private');
    expect(privateRes.ok).toBe(true);
    if (privateRes.ok) {
      expect(privateRes.fee).toBe(0);
    }
  });

  it('🧪 [6.1.2.2] 存量未记账公共教程（ledger <= 0）按文档篇数保底收取书架费', async () => {
    const { chargeShelfFeeAndSave } = await import('@/lib/credits/shelf-fee');

    // 仓库无记账 (transcriptionCreditsEarned = 0)，但有 10 篇文档 -> 保底 5 积分
    savedRepoFindUniqueMock.mockResolvedValueOnce(null);
    repoFindUniqueMock.mockResolvedValueOnce({
      isPublic: true,
      transcriptionCreditsEarned: 0,
      _count: { documents: 10 },
    });
    userFindUniqueMock.mockResolvedValueOnce({ creditBalance: 100 });

    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      fee: 5,
      signupGift: 0,
      alreadySaved: false,
    });
    const res = await chargeShelfFeeAndSave('user-1', 'repo-fallback');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.fee).toBe(5);
      expect(res.alreadySaved).toBe(false);
    }
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/credits/shelf-fee/charge',
      expect.objectContaining({ userId: 'user-1', repositoryId: 'repo-fallback', fee: 5 }),
      expect.anything()
    );
  });


  it('🧪 [6.1.4.1] 余额不足扣减拦截（where: { id, creditBalance: { gte: fee } } 防负数穿透）', async () => {
    const { chargeShelfFeeAndSave } = await import('@/lib/credits/shelf-fee');

    // 场景 1：锁外预读余额为 5，小于 fee (100) -> 立即拦截
    callSidecarMock.mockResolvedValueOnce({
      ok: false,
      code: 'INSUFFICIENT_BALANCE',
      balance: 5,
      fee: 100,
    });
    const insufficientRes = await chargeShelfFeeAndSave('user-poor', 'repo-expensive');
    expect(insufficientRes.ok).toBe(false);
    if (!insufficientRes.ok) {
      expect(insufficientRes.code).toBe('INSUFFICIENT_BALANCE');
      expect(insufficientRes.balance).toBe(5);
      expect(insufficientRes.fee).toBe(100);
    }

    // 场景 2：并发扣减竞争中，updateMany 条件 where: { creditBalance: { gte: fee } } 返回 0 行
    callSidecarMock.mockResolvedValueOnce({
      ok: false,
      code: 'INSUFFICIENT_BALANCE',
    });
    const raceRes = await chargeShelfFeeAndSave('user-race', 'repo-expensive');
    expect(raceRes.ok).toBe(false);
    if (!raceRes.ok) {
      expect(raceRes.code).toBe('INSUFFICIENT_BALANCE');
    }
  });

  it('🧪 [6.5.1.1] 导入结束零扣费：私有导入 0 消耗且无需预扣与多退少补', async () => {
    const { settleImportBilling } = await import('@/lib/credits/import-billing');
    const { getDynamicCreditsConfig } = await import('@/lib/credits-config');
    const config = await getDynamicCreditsConfig();

    // （入场预估已随提交期积分准入退役删除——零扣费语义现由结算口径直接锁定）

    // 实际转录仅处理了 3 篇文档
    const settled = settleImportBilling({
      actualDocCount: 3,
      isPublic: false,
      config,
    });
    const actualSpentCredits = settled.finalCredits; // 0 消耗
    expect(actualSpentCredits).toBe(0);
    expect(settled.rewardCredits).toBe(0);
  });

  it('🧪 [6.1.1.2] 负数与非法输入防线：computeShelfFee 面对 NaN, Infinity, 负数倍率/账本坚决归零', async () => {
    const { computeShelfFee } = await import('@/lib/credits/shelf-fee');

    // 负数倍率与非法输入
    expect(computeShelfFee(100, -1)).toBe(0);
    expect(computeShelfFee(100, NaN)).toBe(0);
    expect(computeShelfFee(100, Infinity)).toBe(0);

    // 负数账本与非法文档数
    expect(computeShelfFee(-50, 1.0)).toBe(0);
    expect(computeShelfFee(NaN, 1.0)).toBe(0);
    expect(computeShelfFee(0, 1.0, -10)).toBe(0);
    expect(computeShelfFee(0, 1.0, NaN)).toBe(0);

    // 正常输入
    expect(computeShelfFee(10, 1.5)).toBe(15);
    expect(computeShelfFee(0, 1.0, 5)).toBe(3); // ceil(5 * 0.5) = 3
  });

  it('🧪 [6.1.4.2] 负费用防线：chargeShelfFeeAndSave 面对异常零/负费用以免费 upsert 落库，绝不执行负数扣减', async () => {
    const { chargeShelfFeeAndSave } = await import('@/lib/credits/shelf-fee');

    // 模拟仓库转录积分为负数异常
    repoFindUniqueMock.mockResolvedValueOnce({
      isPublic: true,
      transcriptionCreditsEarned: -999,
      _count: { documents: -5 },
    });

    const res = await chargeShelfFeeAndSave('user-test', 'repo-negative-fee');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.fee).toBe(0);
      expect(res.alreadySaved).toBe(false);
    }
    // 免费走 fee = 0 委托 Go sidecar，不执行负数扣减
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/credits/shelf-fee/charge',
      expect.objectContaining({ userId: 'user-test', repositoryId: 'repo-negative-fee', fee: 0 }),
      expect.anything()
    );
  });
});
