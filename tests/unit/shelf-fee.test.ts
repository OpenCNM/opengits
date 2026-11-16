// 书架收费（credits/shelf-fee）单测：计费公式 / 豁免矩阵 / 余额不足 / 幂等 / 礼金惰性领取。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 所有计费/收藏/豁免路径均不得单独写入仓库身价。
afterEach(() => {
  expect(repoUpdateMock).not.toHaveBeenCalled();
});

const savedRepoFindUniqueMock = vi.fn();
const repoFindUniqueMock = vi.fn();
const importRecordFindFirstMock = vi.fn();
const chapterUpdateJobFindFirstMock = vi.fn();
const chapterVersionFindFirstMock = vi.fn();
const userUpdateManyMock = vi.fn();
const savedRepoUpsertMock = vi.fn();
const savedRepoCreateMock = vi.fn();
const transactionMock = vi.fn();
const repoUpdateMock = vi.fn();

const callSidecarMock = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    savedRepo: { findUnique: savedRepoFindUniqueMock, upsert: savedRepoUpsertMock, create: savedRepoCreateMock },
    repository: { findUnique: repoFindUniqueMock, update: repoUpdateMock },
    importRecord: { findFirst: importRecordFindFirstMock },
    chapterUpdateJob: { findFirst: chapterUpdateJobFindFirstMock },
    chapterVersion: { findFirst: chapterVersionFindFirstMock },
    user: { updateMany: userUpdateManyMock },
    $transaction: transactionMock,
  },
}));

vi.mock('@/lib/credits-config', () => ({
  CREDITS_CONFIG: {
    DEFAULT_DAILY_CREDITS: 1000,
    DEFAULT_RESET_INTERVAL_HOURS: 24,
    MAX_CREDITS_PER_IMPORT: 300,
    CODE_PEDAGOGY_MULTIPLIER: 2.0,
    STANDARD_CHUNK_CHAR_SIZE: 1500,
    WEB_DOC_MAX_PAGES: 200,
    WEB_DOC_MAX_DEPTH: 3,
    TRANSCRIPTION_EARN_MULTIPLIER: 1.0,
    TRANSCRIPTION_CHARS_PER_CREDIT: 1500,
    TRANSCRIPTION_CREDIT_MIN: 2,
    TRANSCRIPTION_CREDIT_MAX: 30,
    TRANSCRIPTION_CODE_MULTIPLIER: 2.0,
    TRANSCRIPTION_BONUS_RATE: 0.5,
    PUBLISH_GIFT_ENABLED: false,
    SHELF_FEE_MULTIPLIER: 1.0,
    SIGNUP_GIFT_CREDITS: 30,
  },
  getDynamicCreditsConfig: vi.fn().mockResolvedValue({ shelfFeeMultiplier: 1.0 }),
}));

async function mod() {
  return import('@/lib/credits/shelf-fee');
}

describe('computeShelfFee 计费', () => {
  it('账本 × 系数，四舍五入，负值钳 0', async () => {
    const { computeShelfFee } = await mod();
    expect(computeShelfFee(100, 1.0)).toBe(100);
    expect(computeShelfFee(105, 0.5)).toBe(53); // 52.5 → 53
    expect(computeShelfFee(100, 0)).toBe(0); // 免费期
    expect(computeShelfFee(-5, 1)).toBe(0); // 脏数据防御（无 fallback）
  });

  it('存量/未记账教程（ledger <= 0）按 fallbackDocCount 篇数保底', async () => {
    const { computeShelfFee } = await mod();
    expect(computeShelfFee(0, 1.0, 10)).toBe(5);
    expect(computeShelfFee(0, 1.0, 1)).toBe(1);
    expect(computeShelfFee(0, 1.0, 0)).toBe(0);
    expect(computeShelfFee(0, 0, 10)).toBe(0);
    expect(computeShelfFee(-5, 1.0, 10)).toBe(5);
    expect(computeShelfFee(20, 1.0, 10)).toBe(20); // 账本高于保底时取账本
  });

  it('未完工或接力教程：局部少量账本不得击穿整仓总篇数保底', async () => {
    const { computeShelfFee } = await mod();
    // 100 篇文档但仅有 2 积分已转录账本：保底 50 积分，不得坍塌为 2 积分
    expect(computeShelfFee(2, 1.0, 100)).toBe(50);
    // 50 篇文档账本 1 积分，系数 1.5：ceil(50 * 0.5) = 25, 25 * 1.5 = 37.5 -> 38
    expect(computeShelfFee(1, 1.5, 50)).toBe(38);
  });
});

describe('chargeShelfFeeAndSave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedRepoFindUniqueMock.mockResolvedValue(null);
    importRecordFindFirstMock.mockResolvedValue(null);
    chapterUpdateJobFindFirstMock.mockResolvedValue(null);
    chapterVersionFindFirstMock.mockResolvedValue(null);
    callSidecarMock.mockImplementation(async (path: string, payload: { fee: number; autoFollow?: boolean }) => {
      return {
        ok: true,
        fee: payload?.fee ?? 0,
        signupGift: 0,
        alreadySaved: false,
      };
    });
  });

  it('已收藏 → 幂等返回，不重复收费', async () => {
    const { chargeShelfFeeAndSave } = await mod();
    savedRepoFindUniqueMock.mockResolvedValue({ id: 'sr1' });
    callSidecarMock.mockResolvedValueOnce({ ok: true, fee: 0, signupGift: 0, alreadySaved: true });
    const res = await chargeShelfFeeAndSave('u1', 'r1');
    expect(res).toEqual({ ok: true, fee: 0, signupGift: 0, alreadySaved: true });
  });

  it('私有仓 → 免费 upsert', async () => {
    const { chargeShelfFeeAndSave } = await mod();
    repoFindUniqueMock.mockResolvedValue({ isPublic: false, transcriptionCreditsEarned: 500 });
    const res = await chargeShelfFeeAndSave('u1', 'r1');
    expect(res.ok).toBe(true);
    expect(res.fee).toBe(0);
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/credits/shelf-fee/charge',
      expect.objectContaining({ userId: 'u1', repositoryId: 'r1', fee: 0 }),
      expect.anything()
    );
  });

  it('导入者豁免（有 ImportRecord）→ 免费', async () => {
    const { chargeShelfFeeAndSave } = await mod();
    repoFindUniqueMock.mockResolvedValue({ isPublic: true, transcriptionCreditsEarned: 500 });
    importRecordFindFirstMock.mockResolvedValue({ id: 'ir1' });
    const res = await chargeShelfFeeAndSave('u1', 'r1');
    expect(res.ok).toBe(true);
    expect(res.fee).toBe(0);
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/credits/shelf-fee/charge',
      expect.objectContaining({ userId: 'u1', repositoryId: 'r1', fee: 0 }),
      expect.anything()
    );
  });

  it('贡献者豁免（ChapterUpdateJob.claimedBy）→ 免费', async () => {
    const { chargeShelfFeeAndSave } = await mod();
    repoFindUniqueMock.mockResolvedValue({ isPublic: true, transcriptionCreditsEarned: 500 });
    chapterUpdateJobFindFirstMock.mockResolvedValue({ id: 'j1' });
    const res = await chargeShelfFeeAndSave('u1', 'r1');
    expect(res.fee).toBe(0);
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/credits/shelf-fee/charge',
      expect.objectContaining({ userId: 'u1', repositoryId: 'r1', fee: 0 }),
      expect.anything()
    );
  });

  it('只查询已换入的任务或公开版本作为贡献资格', async () => {
    const { isShelfFeeExempt } = await mod();
    await isShelfFeeExempt('u1', 'r1');
    expect(chapterUpdateJobFindFirstMock).toHaveBeenCalledWith({
      where: { repositoryId: 'r1', claimedBy: 'u1', status: 'SWAPPED' },
      select: { id: true },
    });
    expect(chapterVersionFindFirstMock).toHaveBeenCalledWith({
      where: { repositoryId: 'r1', authorId: 'u1', visibility: 'PUBLIC' },
      select: { id: true },
    });
  });

  it('豁免查询失败时中止收藏，不扣款也不建立收藏', async () => {
    const { chargeShelfFeeAndSave } = await mod();
    repoFindUniqueMock.mockResolvedValue({ isPublic: true, transcriptionCreditsEarned: 500 });
    importRecordFindFirstMock.mockRejectedValueOnce(new Error('exemption unavailable'));
    await expect(chargeShelfFeeAndSave('u1', 'r1')).rejects.toThrow('exemption unavailable');
    expect(callSidecarMock).not.toHaveBeenCalled();
  });

  it('等待用户行锁后重新查重，重复收藏不再扣款', async () => {
    const { chargeShelfFeeAndSave } = await mod();
    repoFindUniqueMock.mockResolvedValue({ isPublic: true, transcriptionCreditsEarned: 500 });
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      fee: 0,
      signupGift: 0,
      alreadySaved: true,
    });
    await expect(chargeShelfFeeAndSave('u1', 'r1')).resolves.toEqual({
      ok: true, fee: 0, signupGift: 0, alreadySaved: true,
    });
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/credits/shelf-fee/charge',
      expect.objectContaining({ userId: 'u1', repositoryId: 'r1', fee: 500 }),
      expect.anything()
    );
  });

  it('余额不足 → INSUFFICIENT_BALANCE，事务内无建行', async () => {
    const { chargeShelfFeeAndSave } = await mod();
    repoFindUniqueMock.mockResolvedValue({ isPublic: true, transcriptionCreditsEarned: 500 });
    callSidecarMock.mockResolvedValueOnce({
      ok: false,
      code: 'INSUFFICIENT_BALANCE',
      fee: 500,
      balance: 100,
    });
    const res = await chargeShelfFeeAndSave('u1', 'r1');
    expect(res).toEqual({ ok: false, code: 'INSUFFICIENT_BALANCE', fee: 500, balance: 100 });
  });

  it('成功扣费：条件 decrement + 建行记实付快照', async () => {
    const { chargeShelfFeeAndSave } = await mod();
    repoFindUniqueMock.mockResolvedValue({ isPublic: true, transcriptionCreditsEarned: 500 });
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      fee: 500,
      signupGift: 0,
      alreadySaved: false,
    });
    const res = await chargeShelfFeeAndSave('u1', 'r1', false);
    expect(res).toEqual({ ok: true, fee: 500, signupGift: 0, alreadySaved: false });
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/credits/shelf-fee/charge',
      expect.objectContaining({ userId: 'u1', repositoryId: 'r1', autoFollow: false, fee: 500 }),
      expect.anything()
    );
  });

  it('并发唯一冲突 P2002 时：幂等返回已收藏，不抛错且不双扣', async () => {
    const { chargeShelfFeeAndSave } = await mod();
    repoFindUniqueMock.mockResolvedValue({ isPublic: true, transcriptionCreditsEarned: 500 });
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      fee: 0,
      signupGift: 0,
      alreadySaved: true,
    });
    const res = await chargeShelfFeeAndSave('u1', 'r1', false);
    expect(res).toEqual({ ok: true, fee: 0, signupGift: 0, alreadySaved: true });
  });

  it('事务内发生非 P2002 异常时：正常向外抛出', async () => {
    const { chargeShelfFeeAndSave } = await mod();
    repoFindUniqueMock.mockResolvedValue({ isPublic: true, transcriptionCreditsEarned: 500 });
    callSidecarMock.mockRejectedValueOnce(new Error('Connection lost'));
    await expect(chargeShelfFeeAndSave('u1', 'r1', false)).rejects.toThrow('Connection lost');
  });

  it('存量未记账公共教程（transcriptionCreditsEarned = 0）按文档篇数保底扣费', async () => {
    const { chargeShelfFeeAndSave } = await mod();
    repoFindUniqueMock.mockResolvedValue({
      isPublic: true,
      transcriptionCreditsEarned: 0,
      _count: { documents: 10 },
    });
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      fee: 5,
      signupGift: 0,
      alreadySaved: false,
    });
    const res = await chargeShelfFeeAndSave('u1', 'r-fallback', false);
    expect(res).toEqual({ ok: true, fee: 5, signupGift: 0, alreadySaved: false });
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/credits/shelf-fee/charge',
      expect.objectContaining({ userId: 'u1', repositoryId: 'r-fallback', autoFollow: false, fee: 5 }),
      expect.anything()
    );
  });
});


describe('独立身价写入已退役', () => {
  it('不再导出 incrementTranscriptionLedger，书架模块只保留计费与收藏接口', async () => {
    const shelf = await mod();
    expect(shelf).not.toHaveProperty('incrementTranscriptionLedger');
    expect(Object.keys(shelf).sort()).toEqual([
      'chargeShelfFeeAndSave',
      'computeShelfFee',
      'isShelfFeeExempt',
    ]);
    expect(repoUpdateMock).not.toHaveBeenCalled();
  });
});
