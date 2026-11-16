import { describe, expect, it, vi, beforeEach } from 'vitest';

const versionFindUniqueMock = vi.fn();
const versionUpdateMock = vi.fn();
const jobUpdateManyMock = vi.fn();
const userUpdateMock = vi.fn();
const ledgerCreateMock = vi.fn();
const transactionMock = vi.fn();
const docFindUniqueMock = vi.fn();
const contentFindUniqueMock = vi.fn();

const callSidecarMock = vi.fn();

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    chapterVersion: {
      findUnique: (...args: unknown[]) => versionFindUniqueMock(...args),
      update: (...args: unknown[]) => versionUpdateMock(...args),
    },
    chapterUpdateJob: {
      updateMany: (...args: unknown[]) => jobUpdateManyMock(...args),
    },
    user: {
      update: (...args: unknown[]) => userUpdateMock(...args),
    },
    creditGrantLedger: {
      create: (...args: unknown[]) => ledgerCreateMock(...args),
    },
    document: {
      findUnique: (...args: unknown[]) => docFindUniqueMock(...args),
    },
    documentContent: {
      findUnique: (...args: unknown[]) => contentFindUniqueMock(...args),
    },
    $transaction: (...args: unknown[]) => transactionMock(...args),
  },
}));

vi.mock('@/lib/update-market/jobs', () => ({
  postSwap: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/credits/shelf-fee', () => ({
  incrementTranscriptionLedger: vi.fn(),
}));

describe('Retranslate Reward: 市场链路不落台账（BUG-M06-01 修复回归）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishVersion: 公开重译版本发酬已全面退役，base 归 0 且不更新 creditBalance 与不写 CreditGrantLedger', async () => {
    versionFindUniqueMock.mockResolvedValueOnce({
      id: 'ver_1',
      authorId: 'user_1',
      visibility: 'PRIVATE',
      documentId: 'doc_1',
      contentId: 'cnt_1',
    });
    docFindUniqueMock.mockResolvedValueOnce({
      path: 'guides/intro.md',
      repositoryId: 'repo_1',
    });
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      versionId: 'ver_1',
      base: 0,
      canonicalPromoted: false,
      flipMargin: 2,
    });

    const { publishChapterVersion } = await import('@/lib/update-market/versions');
    const res = await publishChapterVersion('ver_1', 'user_1');

    expect(res.base).toBe(0);
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/chapter-versions/publish',
      { versionId: 'ver_1', userId: 'user_1' },
      expect.any(Object)
    );
    expect(transactionMock).not.toHaveBeenCalled();
    // 不回填历史任务金额，不为已退役奖励读取正文或文档。
    expect(jobUpdateManyMock).not.toHaveBeenCalled();
    expect(docFindUniqueMock).not.toHaveBeenCalled();
    expect(contentFindUniqueMock).not.toHaveBeenCalled();
    const { incrementTranscriptionLedger } = await import('@/lib/credits/shelf-fee');
    expect(incrementTranscriptionLedger).not.toHaveBeenCalled();
    expect(userUpdateMock).not.toHaveBeenCalled();
    // 历史缺陷回归锁：base 不写台账
    expect(ledgerCreateMock).not.toHaveBeenCalled();
  });
});