import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { incrementTranscriptionLedger } from '@/lib/credits/shelf-fee';

vi.mock('@/lib/credits/shelf-fee', () => ({ incrementTranscriptionLedger: vi.fn() }));

afterEach(() => {
  expect(incrementTranscriptionLedger).not.toHaveBeenCalled();
  expect(userUpdateMock).not.toHaveBeenCalled();
  expect(ledgerFindFirstMock).not.toHaveBeenCalled();
  expect(ledgerCreateMock).not.toHaveBeenCalled();
  expect(jobUpdateManyMock).not.toHaveBeenCalled();
});

/**
 * 章节版本竞争市场：重译（私有）/ 公开（小额 base）/ 阅读投票（toggle）/
 * 夺位翻正（flipMargin 滞回）/ 版本 GC。
 * Phase 12：写操作全面收编至 Go worker-sidecar 原生单写者端点。
 */

const docFindUniqueMock = vi.fn();
const jobUpdateManyMock = vi.fn();
const userFindUniqueMock = vi.fn();
const userUpdateMock = vi.fn();
const ledgerFindFirstMock = vi.fn();
const ledgerCreateMock = vi.fn();
const callSidecarMock = vi.fn();

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    document: { findUnique: docFindUniqueMock },
    chapterUpdateJob: { updateMany: jobUpdateManyMock },
    user: { findUnique: userFindUniqueMock, update: userUpdateMock },
    creditGrantLedger: { findFirst: ledgerFindFirstMock, create: ledgerCreateMock },
  },
}));

vi.mock('@/lib/tier-limits', () => ({
  isAdminRole: vi.fn((r?: string | null) => r === 'ADMIN'),
}));
vi.mock('@/lib/content-addressing', () => ({
  upsertContentLayer: vi.fn().mockResolvedValue('content-9'),
  computeContentHash: vi.fn(() => 'hash-9'),
  computeRequestFingerprint: vi.fn(() => 'fingerprint-9'),
  isDualWriteEnabled: vi.fn(() => true),
}));
vi.mock('@/lib/update-market/jobs', () => ({
  postSwap: vi.fn(() => Promise.resolve()),
  // relay 生成已下沉 Go staged-relay（2026-10）：重译链经此桩
  generateRelayStagedContent: vi.fn().mockResolvedValue({
    mdx: '# 重译版本\n\n## 小节\n\n' + '重译后的正文内容。'.repeat(60),
    model: 'relay-model',
  }),
}));

async function versions() {
  return import('@/lib/update-market/versions');
}

describe('retranslateChapter / publishChapterVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('重译 → PRIVATE 版本 + RETRANSLATE 记账行（baseCredits=0，无入账）', async () => {
    const m = await versions();
    docFindUniqueMock.mockResolvedValue({
      path: 'docs/a.md',
      repositoryId: 'repo-1',
      repository: { gitSha: 'f'.repeat(40) },
    });
    callSidecarMock.mockImplementation(async (endpoint: string) => {
      if (endpoint === '/v1/chapter-versions/create') {
        return { ok: true, versionId: 'v-new' };
      }
      if (endpoint === '/v1/market/jobs/retranslate-record') {
        return { ok: true };
      }
      return { ok: true };
    });

    const r = await m.retranslateChapter('doc-1', 'u1');
    expect(r.versionId).toBe('v-new');
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/chapter-versions/create',
      expect.objectContaining({
        documentId: 'doc-1',
        repositoryId: 'repo-1',
        authorId: 'u1',
        contentId: 'content-9',
        source: 'RETRANSLATE',
        visibility: 'PRIVATE',
      }),
      expect.anything()
    );
    const { upsertContentLayer } = await import('@/lib/content-addressing');
    expect(upsertContentLayer).toHaveBeenCalledWith(
      expect.objectContaining({
        requestFingerprint: 'fingerprint-9',
      })
    );
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/market/jobs/retranslate-record',
      expect.objectContaining({
        repositoryId: 'repo-1',
        documentId: 'doc-1',
        path: 'docs/a.md',
        userId: 'u1',
      }),
      expect.anything()
    );
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  // 🧪 [5.3.1.1 · CRITICAL] 反复将版本在私有与公开之间切换套取多次首发奖励
  it('5.3.1.1 公开 → visibility 翻 PUBLIC + base 归 0（发酬已退役，不增发积分）', async () => {
    const m = await versions();
    callSidecarMock.mockImplementation(async (endpoint: string) => {
      if (endpoint === '/v1/chapter-versions/publish') {
        return { ok: true, notFound: false, forbidden: false, base: 0 };
      }
      return { ok: true };
    });

    const r = await m.publishChapterVersion('v-1', 'u1');
    expect(r.base).toBe(0);
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/chapter-versions/publish',
      { versionId: 'v-1', userId: 'u1' },
      expect.anything()
    );
    expect(jobUpdateManyMock).not.toHaveBeenCalled();
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it('非作者公开/删除 → NOT_FOUND；公开版本删除 → INVALID_STATE', async () => {
    const m = await versions();
    callSidecarMock.mockImplementation(async (endpoint: string) => {
      if (endpoint === '/v1/chapter-versions/publish') {
        return { ok: false, notFound: true, base: 0 };
      }
      if (endpoint === '/v1/chapter-versions/delete') {
        return { ok: false, invalidState: true };
      }
      return { ok: true };
    });

    await expect(m.publishChapterVersion('v-1', 'u1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(m.deletePrivateVersion('v-1', 'u1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('toggleChapterVersionVote + maybeFlipCanonical（夺位滞回）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('自票拒绝；私有版本投票拒绝', async () => {
    const m = await versions();
    callSidecarMock.mockResolvedValueOnce({ ok: false, selfVote: true });
    await expect(m.toggleChapterVersionVote('v-1', 'u1')).rejects.toMatchObject({ code: 'SELF_VOTE' });

    callSidecarMock.mockResolvedValueOnce({ ok: false, invalidState: true });
    await expect(m.toggleChapterVersionVote('v-1', 'u2')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  // 🧪 [5.3.2.1 · HIGH] 票数 1:1 相等时正典在两个版本之间频繁翻转闪烁
  it('5.3.2.1 投票 toggle 上下行 + 领先 1 票不翻正（flipMargin=2 滞回）', async () => {
    const m = await versions();
    callSidecarMock.mockImplementation(async (endpoint: string) => {
      if (endpoint === '/v1/chapter-versions/vote') {
        return { ok: true, voted: true, voteCount: 6, documentId: 'doc-1' };
      }
      if (endpoint === '/v1/chapter-versions/promote') {
        return { ok: true, flipped: false, reason: 'MARGIN_NOT_MET' };
      }
      return { ok: true };
    });

    const r = await m.toggleChapterVersionVote('v-1', 'u2');
    expect(r.voted).toBe(true);
    expect(r.voteCount).toBe(6);
    expect(r.canonicalChanged).toBe(false);
  });

  // 🧪 [5.3.3.1 · CRITICAL] 翻正成功后积分已增发但 document.contentId 切换失败
  it('5.3.3.1 领先达 flipMargin → 夺位翻正：指针翻转 + isCanonical CAS 互换（加赠已退役，零增发）+ 双通知', async () => {
    const m = await versions();
    callSidecarMock.mockImplementation(async (endpoint: string) => {
      if (endpoint === '/v1/chapter-versions/vote') {
        return { ok: true, voted: true, voteCount: 7, documentId: 'doc-1' };
      }
      if (endpoint === '/v1/chapter-versions/promote') {
        return {
          ok: true,
          flipped: true,
          canonicalVersionId: 'challenger',
          previousVersionId: 'incumbent',
          reason: 'SUCCESS',
        };
      }
      return { ok: true };
    });

    const r = await m.toggleChapterVersionVote('v-1', 'u2');
    expect(r.canonicalChanged).toBe(true);
    expect(userUpdateMock).not.toHaveBeenCalled();
    expect(ledgerCreateMock).not.toHaveBeenCalled();
  });

  it('平票维持现状；无正典边界 → 最高票补位', async () => {
    const m = await versions();
    callSidecarMock.mockImplementation(async (endpoint: string) => {
      if (endpoint === '/v1/chapter-versions/vote') {
        return { ok: true, voted: true, voteCount: 5, documentId: 'doc-1' };
      }
      if (endpoint === '/v1/chapter-versions/promote') {
        return { ok: true, flipped: false, reason: 'MARGIN_NOT_MET' };
      }
      return { ok: true };
    });

    const r = await m.toggleChapterVersionVote('v-1', 'u2');
    expect(r.canonicalChanged).toBe(false);

    // 无正典：最高票直接补位
    callSidecarMock.mockImplementation(async (endpoint: string) => {
      if (endpoint === '/v1/chapter-versions/vote') {
        return { ok: true, voted: true, voteCount: 9, documentId: 'doc-1' };
      }
      if (endpoint === '/v1/chapter-versions/promote') {
        return { ok: true, flipped: true, canonicalVersionId: 'top', reason: 'SUCCESS' };
      }
      return { ok: true };
    });
    const r2 = await m.toggleChapterVersionVote('v-1', 'u2');
    expect(r2.canonicalChanged).toBe(true);
  });

  // 🧪 [5.3.4.1 · HIGH] 维护者钦定的低票正典被高票挑战者自动翻走，钦定语义失效
  it('5.3.4.1 维护者钦定正典（pinnedAt 非空）对投票夺位免疫：作者裁决 > 社区净好评', async () => {
    const m = await versions();
    callSidecarMock.mockImplementation(async (endpoint: string) => {
      if (endpoint === '/v1/chapter-versions/vote') {
        return { ok: true, voted: true, voteCount: 9, documentId: 'doc-1' };
      }
      if (endpoint === '/v1/chapter-versions/promote') {
        return { ok: true, flipped: false, canonicalVersionId: 'incumbent', reason: 'MAINTAINER_PINNED_IMMUNE' };
      }
      return { ok: true };
    });

    const r = await m.toggleChapterVersionVote('v-1', 'u2');
    expect(r.canonicalChanged).toBe(false);
    expect(userUpdateMock).not.toHaveBeenCalled();
  });
});

describe('pinChapterVersion（维护者一票推荐置顶）', () => {
  it('维护者一键设为推荐正典：更新 isCanonical + 指针同步', async () => {
    const m = await versions();
    userFindUniqueMock.mockResolvedValue({ role: null });
    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      success: true,
      flipped: true,
      documentId: 'doc-1',
      postSwapPayload: {
        repositoryId: 'repo-1',
        documentId: 'doc-1',
        path: 'docs/ch1.md',
        contentId: 'content-cand',
        content: '# 推荐版本内容',
      },
    });

    const r = await m.pinChapterVersion('v-cand', 'm-1');
    expect(r.success).toBe(true);
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/chapter-versions/pin',
      expect.objectContaining({
        versionId: 'v-cand',
        userId: 'm-1',
        isAdmin: false,
      }),
      expect.anything()
    );
  });

  it('非维护者操作抛出 403 FORBIDDEN', async () => {
    const m = await versions();
    userFindUniqueMock.mockResolvedValue({ role: null });
    callSidecarMock.mockResolvedValueOnce({
      ok: false,
      forbidden: true,
      error: 'forbidden',
    });

    await expect(m.pinChapterVersion('v-cand', 'random-user')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
