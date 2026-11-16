import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 章节更新市场租约时序单测（ChapterUpdateJob FSM · Node 守卫层）。
 *
 * 物理事实锚定（346·公理 1）——幽灵写入防御在 Node 层的实现是
 * `runStagedTranscription` 入口的 status/claimedBy/claimedUntil 三重守卫
 * （apps/client/src/lib/update-market/jobs.ts:277-284）；
 * 真正的并发仲裁在 Go 侧 SQL CAS（queries/market.sql 的
 * MarketClaimJob / MarketExtendClaim / MarketSettleRelayTxUpdateJob /
 * MarketMarkJobFailed 守卫，由 internal/market/cas_anchor_test.go 锚定）。
 * 本文件锁定：非法状态下 Node 侧零副作用（不触发生成、不落 settle）、
 * 错误码映射矩阵、以及认领/放弃的租约参数透传。
 */

const chapterUpdateJobFindUniqueMock = vi.fn();
const savedRepoFindManyMock = vi.fn().mockResolvedValue([]);
const notificationFindManyMock = vi.fn().mockResolvedValue([]);
const documentCountMock = vi.fn().mockResolvedValue(0);
const callSidecarMock = vi.fn();

const claimMock = vi.fn();
const releaseMock = vi.fn();
const extendClaimMock = vi.fn();
const relaySettleMock = vi.fn();
const markFailedMock = vi.fn();
const ensureRelayMock = vi.fn();
const createStaleMock = vi.fn();
const l0GateMock = vi.fn();
let emergencyReadOnly = false;

vi.mock('@/lib/db', () => ({
  prisma: {
    chapterUpdateJob: {
      findUnique: (...a: unknown[]) => chapterUpdateJobFindUniqueMock(...a),
    },
    savedRepo: { findMany: (...a: unknown[]) => savedRepoFindManyMock(...a) },
    notification: { findMany: (...a: unknown[]) => notificationFindManyMock(...a) },
    document: { count: (...a: unknown[]) => documentCountMock(...a) },
  },
}));

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...a: unknown[]) => callSidecarMock(...a),
}));

vi.mock('@/lib/gateway/policy', () => ({
  isEmergencyReadOnly: async () => emergencyReadOnly,
}));

vi.mock('@/engine/market-driver', () => ({
  executeSidecarMarketJobClaim: (...a: unknown[]) => claimMock(...a),
  executeSidecarMarketJobRelease: (...a: unknown[]) => releaseMock(...a),
  executeSidecarMarketJobExtendClaim: (...a: unknown[]) => extendClaimMock(...a),
  executeSidecarMarketJobRelaySettle: (...a: unknown[]) => relaySettleMock(...a),
  executeSidecarMarketJobMarkFailed: (...a: unknown[]) => markFailedMock(...a),
  executeSidecarMarketJobEnsureRelay: (...a: unknown[]) => ensureRelayMock(...a),
  executeSidecarMarketJobCreateStale: (...a: unknown[]) => createStaleMock(...a),
}));

vi.mock('@/lib/update-market/gate', () => ({
  l0Gate: (...a: unknown[]) => l0GateMock(...a),
}));

vi.mock('@/lib/notifications/notification-sender', () => ({
  sendNotifications: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/observability/errors', () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/mcp/document-graph-sync', () => ({
  syncDocumentKnowledgeGraph: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/content-addressing', () => ({
  upsertContentLayer: vi.fn().mockResolvedValue('content-id-1'),
  computeContentHash: vi.fn(() => 'hash-1'),
  computeRequestFingerprint: vi.fn(() => 'fp-1'),
  isDualWriteEnabled: vi.fn(() => false),
}));

vi.mock('@/lib/transcription/fingerprint', () => ({
  fingerprintInputsFor: vi.fn(() => ({})),
}));

vi.mock('@/lib/transcription/types', () => ({
  toProfileRecord: vi.fn(() => null),
}));

vi.mock('@/engine/repo-tarball', () => ({
  ensureArchive: vi.fn().mockResolvedValue(undefined),
}));

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    documentId: 'doc-1',
    repositoryId: 'repo-1',
    path: 'guide/arch.md',
    kind: 'UPDATE',
    status: 'CLAIMED',
    claimedBy: 'u-1',
    claimedUntil: new Date(Date.now() + 60_000),
    fromSha: 'aaaa1111',
    toSha: 'bbbb2222',
    document: { content: '旧版正文', path: 'guide/arch.md', contentRef: null },
    repository: { id: 'repo-1', owner: 'owner', repo: 'repo', gitSha: 'cccc3333', repoProfile: null },
    ...overrides,
  };
}

/** 断言零副作用：非法状态下不得触发任何生成 / settle / mark-failed sidecar 调用 */
function expectNoSidecarSideEffects() {
  expect(callSidecarMock).not.toHaveBeenCalled();
  expect(relaySettleMock).not.toHaveBeenCalled();
  expect(markFailedMock).not.toHaveBeenCalled();
}

import {
  abandonClaim,
  claimJob,
  ensureRelayJobForDocument,
  runStagedTranscription,
  UpdateMarketError,
} from '@/lib/update-market/jobs';

describe('更新市场租约生命周期（claimJob / abandonClaim / ensureRelay）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emergencyReadOnly = false;
    claimMock.mockResolvedValue({ frozenCredits: 0 });
    releaseMock.mockResolvedValue(undefined);
    ensureRelayMock.mockResolvedValue({ id: 'job-relay-1', repositoryId: 'repo-1', kind: 'RELAY', status: 'PENDING' });
  });

  it('claimJob 透传租约 TTL（默认 30min）', async () => {
    const res = await claimJob('job-1', 'u-1');
    expect(res).toEqual({ frozenCredits: 0 });
    expect(claimMock).toHaveBeenCalledTimes(1);
    expect(claimMock).toHaveBeenCalledWith('job-1', 'u-1', 30);
  });

  it('全站维护（EMERGENCY_READONLY）时认领与建单均失败封闭，零 sidecar 调用', async () => {
    emergencyReadOnly = true;
    await expect(claimJob('job-1', 'u-1')).rejects.toMatchObject({ code: 'EMERGENCY_READONLY' });
    await expect(ensureRelayJobForDocument('doc-1')).rejects.toMatchObject({ code: 'EMERGENCY_READONLY' });
    expect(claimMock).not.toHaveBeenCalled();
    expect(ensureRelayMock).not.toHaveBeenCalled();
  });

  it('abandonClaim 成功释放回 PENDING；失败映射 INVALID_STATE', async () => {
    await abandonClaim('job-1', 'u-1');
    expect(releaseMock).toHaveBeenCalledWith('job-1', 'u-1');

    releaseMock.mockRejectedValueOnce(new Error('sidecar 409: 状态已变化'));
    await expect(abandonClaim('job-1', 'u-1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('mapSidecarError 映射矩阵：ALREADY_CLAIMED / NOT_FOUND / INVALID_STATE / 409 / 原样透传', async () => {
    const cases: Array<{ message: string; expectedCode: string }> = [
      { message: 'job ALREADY_CLAIMED by other user', expectedCode: 'ALREADY_CLAIMED' },
      { message: 'job NOT_FOUND in market store', expectedCode: 'NOT_FOUND' },
      { message: 'INVALID_STATE: job not claimable', expectedCode: 'INVALID_STATE' },
      { message: 'sidecar responded 409 Conflict', expectedCode: 'INVALID_STATE' },
    ];
    for (const c of cases) {
      claimMock.mockRejectedValueOnce(new Error(c.message));
      const err = await claimJob('job-1', 'u-1').catch((e: UpdateMarketError) => e);
      expect(err).toBeInstanceOf(UpdateMarketError);
      expect(err.code).toBe(c.expectedCode);
    }
    // 未知错误原样透传（不吞不换）
    const raw = new Error('ECONNREFUSED sidecar unreachable');
    claimMock.mockRejectedValueOnce(raw);
    await expect(claimJob('job-1', 'u-1')).rejects.toBe(raw);
  });
});

describe('runStagedTranscription 幽灵写入防御（Node 守卫层时序）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emergencyReadOnly = false;
    markFailedMock.mockResolvedValue(undefined);
  });

  it.each([
    'PENDING', 'TRIAL', 'SWAPPED', 'REJECTED', 'FAILED', 'CANCELLED',
  ] as const)('status=%s（非 CLAIMED）→ INVALID_STATE 且零副作用', async (status) => {
    chapterUpdateJobFindUniqueMock.mockResolvedValueOnce(makeJob({ status }));
    await expect(runStagedTranscription('job-1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expectNoSidecarSideEffects();
  });

  it('CLAIMED 但 claimedBy 为空（租约已被回池清扫）→ INVALID_STATE 且零副作用', async () => {
    chapterUpdateJobFindUniqueMock.mockResolvedValueOnce(makeJob({ claimedBy: null }));
    await expect(runStagedTranscription('job-1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expectNoSidecarSideEffects();
  });

  it('claimedUntil 已过期（真实 Date 偏移：租约时钟越过 now）→ INVALID_STATE「已超时回池」且零副作用', async () => {
    chapterUpdateJobFindUniqueMock.mockResolvedValueOnce(
      makeJob({ claimedUntil: new Date(Date.now() - 1_000) }),
    );
    const err = await runStagedTranscription('job-1').catch((e: UpdateMarketError) => e);
    expect(err.code).toBe('INVALID_STATE');
    expect(err.message).toContain('认领已超时');
    expectNoSidecarSideEffects();
  });

  it('任务不存在 → NOT_FOUND 且零副作用', async () => {
    chapterUpdateJobFindUniqueMock.mockResolvedValueOnce(null);
    await expect(runStagedTranscription('job-404')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expectNoSidecarSideEffects();
  });

  it('三源 SHA 全空 → INVALID_STATE 且零副作用', async () => {
    chapterUpdateJobFindUniqueMock.mockResolvedValueOnce(
      makeJob({ fromSha: null, toSha: '  ', repository: { id: 'repo-1', owner: 'o', repo: 'r', gitSha: null, repoProfile: null } }),
    );
    const err = await runStagedTranscription('job-1').catch((e: UpdateMarketError) => e);
    expect(err.code).toBe('INVALID_STATE');
    expect(err.message).toContain('缺少代码版本');
    expectNoSidecarSideEffects();
  });

  it('合法租约（claimedUntil 未来）放行：UPDATE 分支过 L0 门后 settle 携带本人身份', async () => {
    chapterUpdateJobFindUniqueMock.mockResolvedValueOnce(makeJob());
    callSidecarMock.mockResolvedValueOnce({ content: '# 新版正文', model: 'gpt-test' });
    l0GateMock.mockReturnValueOnce({ passed: true, reason: '' });

    const res = await runStagedTranscription('job-1');
    expect(res).toEqual({ baseCredits: 0 });
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/transcription/staged-generate',
      expect.objectContaining({ documentId: 'doc-1', userId: 'u-1', sourceSha: 'bbbb2222' }),
      expect.objectContaining({ label: 'transcription-staged-generate' }),
    );
    expect(relaySettleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        userId: 'u-1',
        documentId: 'doc-1',
        stagedContentId: 'content-id-1',
        stagedModel: 'gpt-test',
        toSha: 'bbbb2222',
      }),
    );
    // 守卫放行后未被置败
    expect(markFailedMock).not.toHaveBeenCalled();
  });

  it('L0 门禁拒绝 → markFailed 落 FAILED 终态并携带失败原因', async () => {
    chapterUpdateJobFindUniqueMock.mockResolvedValueOnce(makeJob());
    callSidecarMock.mockResolvedValueOnce({ content: '# 丢代码块的劣化译文', model: 'gpt-test' });
    l0GateMock.mockReturnValueOnce({ passed: false, reason: '代码块保全率 0.4 < 0.9' });

    await expect(runStagedTranscription('job-1')).rejects.toThrow('L0 门禁未过');
    expect(markFailedMock).toHaveBeenCalledTimes(1);
    expect(markFailedMock).toHaveBeenCalledWith(
      'job-1',
      'u-1',
      expect.stringContaining('L0 门禁未过'),
    );
  });

  it('幽灵 settle：生成成功但租约已被抢占（settle CAS 409）→ markFailed 以原认领人身份落败', async () => {
    chapterUpdateJobFindUniqueMock.mockResolvedValueOnce(
      makeJob({ kind: 'RELAY' }),
    );
    callSidecarMock.mockResolvedValueOnce({ mdx: '# RELAY 成稿', model: 'm-relay' });
    relaySettleMock.mockRejectedValueOnce(new Error('HTTP 409: INVALID_STATE settle rejected'));

    const err = await runStagedTranscription('job-1').catch((e: UpdateMarketError) => e);
    expect(err.code).toBe('INVALID_STATE');
    // 关键时序：markFailed 必须以 jobs 行快照中的 claimedBy（非他人）提交 CAS
    expect(markFailedMock).toHaveBeenCalledWith(
      'job-1',
      'u-1',
      expect.stringContaining('INVALID_STATE'),
    );
  });
});
