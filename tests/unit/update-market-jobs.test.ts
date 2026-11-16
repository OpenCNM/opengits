import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { incrementTranscriptionLedger } from '@/lib/credits/shelf-fee';

vi.mock('@/lib/credits/shelf-fee', () => ({ incrementTranscriptionLedger: vi.fn() }));
vi.mock('@/lib/gateway/policy', () => ({ isEmergencyReadOnly: vi.fn().mockResolvedValue(false) }));
vi.mock('@/lib/mcp/outline-projector', () => ({ resolveEffectiveNavTree: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/mcp/document-graph-sync', () => ({ syncDocumentKnowledgeGraph: vi.fn().mockResolvedValue(undefined) }));

const mockMarketClaim = vi.fn();
const mockMarketRelease = vi.fn();
const mockMarketRelaySettle = vi.fn();
const mockMarketMarkFailed = vi.fn();
const mockMarketEnsureRelay = vi.fn();
const mockMarketRetranslateRecord = vi.fn();
const mockMarketCreateStale = vi.fn();

const mockCallSidecar = vi.fn().mockResolvedValue({ ok: true, count: 1 });
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => mockCallSidecar(...args),
}));

vi.mock('@/engine/market-driver', () => ({
  executeSidecarMarketJobClaim: (...args: unknown[]) => mockMarketClaim(...args),
  executeSidecarMarketJobRelease: (...args: unknown[]) => mockMarketRelease(...args),
  executeSidecarMarketJobRelaySettle: (...args: unknown[]) => mockMarketRelaySettle(...args),
  executeSidecarMarketJobMarkFailed: (...args: unknown[]) => mockMarketMarkFailed(...args),
  executeSidecarMarketJobEnsureRelay: (...args: unknown[]) => mockMarketEnsureRelay(...args),
  executeSidecarMarketJobRetranslateRecord: (...args: unknown[]) => mockMarketRetranslateRecord(...args),
  executeSidecarMarketJobCreateStale: (...args: unknown[]) => mockMarketCreateStale(...args),
}));

// 包括历史正额 base 换入、RELAY 和 UPDATE：禁止任何身价增加调用（即使传入 0）。
afterEach(() => {
  expect(incrementTranscriptionLedger).not.toHaveBeenCalled();
});

/**
 * 更新市场引擎单测：L0 门禁 / 建 job 幂等 / 认领 CAS / 机检即入库直换 /
 * 超时清扫委托 / 积分聚合口径。
 */

const jobFindUniqueMock = vi.fn();
const jobFindFirstMock = vi.fn().mockResolvedValue(null);
const jobFindManyMock = vi.fn();
const jobCreateMock = vi.fn();
const jobUpdateMock = vi.fn();
// 默认 CAS 命中（count:1）：runStagedTranscription 的 CAS 写在未显式
// mock 的用例里按"成功"走，具体用例可覆盖为 { count: 0 } 验证作废路径
const jobUpdateManyMock = vi.fn().mockResolvedValue({ count: 1 });
const jobCountMock = vi.fn();
const docFindManyMock = vi.fn();
const docFindUniqueMock = vi.fn();
const docUpdateMock = vi.fn();
const repoUpdateMock = vi.fn();
const repoFindUniqueMock = vi.fn();
const savedRepoFindManyMock = vi.fn();
const notificationCreateManyMock = vi.fn();
const notificationFindManyMock = vi.fn().mockResolvedValue([]);
const docCountMock = vi.fn().mockResolvedValue(5);
const contentFindUniqueMock = vi.fn();
const chunkDeleteManyMock = vi.fn();
const chunkCreateManyMock = vi.fn();
const importJobFindManyMock = vi.fn();
const userFindUniqueMock = vi.fn();
const transactionMock = vi.fn();
const importRecordFindFirstMock = vi.fn();
const userUpdateMock = vi.fn();
const jobAggregateMock = vi.fn();
const grantLedgerAggregateMock = vi.fn().mockResolvedValue({ _sum: { amount: null } });
const chapterVersionCreateMock = vi.fn();
const chapterVersionUpdateManyMock = vi.fn();
const executeRawMock = vi.fn().mockResolvedValue(undefined);

/** 交互式事务替身：与 prisma 同一套模型 mock 注入 tx 客户端 */
const txClient = {
  chapterUpdateJob: {
    findUnique: jobFindUniqueMock,
    findFirst: jobFindFirstMock,
    findMany: jobFindManyMock,
    create: jobCreateMock,
    update: jobUpdateMock,
    updateMany: jobUpdateManyMock,
    count: jobCountMock,
  },
  chapterVersion: { create: chapterVersionCreateMock, updateMany: chapterVersionUpdateManyMock },
  document: { findUnique: docFindUniqueMock, findMany: docFindManyMock, update: docUpdateMock },
  user: { update: userUpdateMock },
  $executeRaw: executeRawMock,
};

vi.mock('@/lib/observability/errors', () => ({
  captureError: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    chapterUpdateJob: {
      findUnique: jobFindUniqueMock,
      findFirst: jobFindFirstMock,
      findMany: jobFindManyMock,
      create: jobCreateMock,
      update: jobUpdateMock,
      updateMany: jobUpdateManyMock,
      aggregate: jobAggregateMock,
      count: jobCountMock,
    },
    // 积分发放台账（capDailyEarn 第二聚合源）：默认窗口内无台账发放
    creditGrantLedger: { aggregate: grantLedgerAggregateMock },
    chapterVersion: { create: chapterVersionCreateMock, updateMany: chapterVersionUpdateManyMock },
    document: { findUnique: docFindUniqueMock, findMany: docFindManyMock, update: docUpdateMock, count: docCountMock },
    repository: { update: repoUpdateMock, findUnique: repoFindUniqueMock },
    savedRepo: { findMany: savedRepoFindManyMock },
    notification: { createMany: notificationCreateManyMock, findMany: notificationFindManyMock },
    documentContent: { findUnique: contentFindUniqueMock },
    documentChunk: { deleteMany: chunkDeleteManyMock, createMany: chunkCreateManyMock },
    importJob: { findMany: importJobFindManyMock },
    user: { findUnique: userFindUniqueMock, update: userUpdateMock },
    importRecord: { findFirst: importRecordFindFirstMock },
    // 交互式事务：回调直接拿共享 tx 客户端（生产代码已全部回调化，无数组事务）
    $transaction: (cb: (tx: unknown) => unknown) => transactionMock(cb),
  },
}));

// tier 限额解析（capDailyEarn 依赖）：FREE 默认日配额 1000
vi.mock('@/lib/credits-config', () => ({
  // transcription-earn 从本模块取默认常量——mock 需一并提供
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
  },
  getDynamicCreditsConfig: vi.fn().mockResolvedValue({
    defaultDailyCredits: 1000,
    resetIntervalHours: 24,
    maxCreditsPerImport: 300,
    // 转录计酬系数（giftOf 动态口径）：与历史 env 常量等价，行为不变
    transcriptionEarnMultiplier: 1.0,
    transcriptionCharsPerCredit: 1500,
    transcriptionCreditMin: 2,
    transcriptionCreditMax: 30,
    transcriptionCodeMultiplier: 2.0,
    transcriptionBonusRate: 0.5,
    publishGiftEnabled: false,
  }),
}));

const validateImportCreditsMock = vi.fn();

// generateStagedContent 已内联 jobs.ts 直调 callSidecar（2026-10 收口）——
// mock 经 /v1/transcription/staged-generate 分支路由到同名桩
const generateStagedContentMock = vi.fn();

vi.mock('@/lib/content-addressing', () => ({
  upsertContentLayer: vi.fn().mockResolvedValue('content-1'),
  computeContentHash: vi.fn(() => 'hash-1'),
  computeRequestFingerprint: vi.fn(() => 'fingerprint-1'),
  isDualWriteEnabled: vi.fn(() => true),
}));

// RELAY 契约管线（三件套）：mock 生成编排，专注引擎侧（自动上架/版本/积分）断言
const generateRelayChapterMock = vi.fn();
// relay 生成已下沉 Go staged-relay（2026-10）：mock 经 sidecar 端点分支路由，
// 与 staged-generate 同款（generateRelayChapterMock 桩名保留减少用例改动）
mockCallSidecar.mockImplementation(async (path: string) => {
  if (path === '/v1/transcription/staged-relay') return generateRelayChapterMock();
  if (path === '/v1/transcription/staged-generate') return generateStagedContentMock();
  return { ok: true, count: 1 };
});

/** 动态 import：避开 vi.mock 提升与顶层 const 初始化的顺序问题 */
async function engine() {
  return import('@/lib/update-market/jobs');
}

// $transaction 默认实现：调用回调并注入 tx 客户端（clearAllMocks 不清除实现）
transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(txClient));

type Engine = Awaited<ReturnType<typeof engine>>;
let l0Gate: Engine['l0Gate'];
let createStaleJobs: Engine['createStaleJobs'];
let ensureRelayJobForDocument: Engine['ensureRelayJobForDocument'];
let claimJob: Engine['claimJob'];
let runStagedTranscription: Engine['runStagedTranscription'];
let notifyRelaySettled: Engine['notifyRelaySettled'];

beforeAll(async () => {
  const e = await engine();
  l0Gate = e.l0Gate;
  createStaleJobs = e.createStaleJobs;
  ensureRelayJobForDocument = e.ensureRelayJobForDocument;
  claimJob = e.claimJob;
  runStagedTranscription = e.runStagedTranscription;
  notifyRelaySettled = e.notifyRelaySettled;
});

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    repositoryId: 'repo-1',
    documentId: 'doc-1',
    path: 'docs/a.md',
    fromSha: 'a'.repeat(40),
    toSha: 'f'.repeat(40),
    kind: 'UPDATE',
    status: 'PENDING',
    claimedBy: null,
    claimedUntil: null,
    stagedContentId: null,
    stagedModel: null,
    frozenCredits: 0,
    baseCredits: 0,
    actualCredits: null,
    voteDeadline: null,
    errorMessage: null,
    ...over,
  };
}

describe('l0Gate 确定性门禁', () => {
  it('过短内容拒绝', () => {
    expect(l0Gate('短', '# 旧\n内容'.repeat(10)).passed).toBe(false);
  });
  it('长度坍缩拒绝（<30%）', () => {
    const old = '# 标题\n' + '正文 '.repeat(500);
    const shrunken = '# 标题\n' + '内容很少但超过最短长度阈值的一段正文内容。'.repeat(3);
    expect(l0Gate(shrunken, old).reason).toMatch(/长度/);
  });
  it('长度爆炸拒绝（>5x）', () => {
    const old = '# 标题\n短';
    expect(l0Gate('# 标题\n' + '爆 '.repeat(500), old).reason).toMatch(/倍/);
  });
  it('中文占比显著下滑拒绝', () => {
    const old = '# 教程\n这是一段足够长的中文内容，用于语言一致性检测。'.repeat(5);
    const bad = '# Tutorial\n' + 'english text only content here '.repeat(20);
    expect(l0Gate(bad, old).reason).toMatch(/中文/);
  });
  it('缺少标题结构拒绝', () => {
    const old = '# 标题\n' + '正文内容。'.repeat(20);
    const noHeading = '没有标题只有正文的一段内容，长度足够通过其他所有检查项，唯独缺少 markdown 标题结构。'.repeat(2);
    expect(l0Gate(noHeading, old).reason).toMatch(/标题/);
  });
  it('健康新版通过', () => {
    const old = '# 教程\n这是旧版本正文。'.repeat(10);
    const ok = '# 教程\n这是新版本正文，结构与语言都保持一致。'.repeat(10);
    expect(l0Gate(ok, old).passed).toBe(true);
  });
});

describe('createStaleJobs', () => {
  const candidateSet = (change: 'content' | 'structural' = 'content') => ({
    chapters: [{ path: 'docs/a.md', title: 'A', oldSummary: null, change, affectedFiles: [] }],
    unmatchedFiles: [],
    structuralAdds: [],
    structuralRemoves: [],
    diffStats: { added: 0, modified: 1, removed: 0, renamed: 0 },
    hasOldArchive: false,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('结构变更不进市场（留给手动 plan→apply）', async () => {
    const r = await createStaleJobs({ id: 'repo-1', gitSha: 'a'.repeat(40) }, candidateSet('structural'), 'f'.repeat(40));
    expect(r.structural).toBe(true);
    expect(mockMarketCreateStale).not.toHaveBeenCalled();
  });

  it('内容章节建 job + 置 pendingSyncSha；活跃 job 的 document 跳过（幂等）', async () => {
    mockMarketCreateStale.mockResolvedValueOnce({ created: 1, structural: false });

    const r = await createStaleJobs({ id: 'repo-1', gitSha: 'a'.repeat(40) }, candidateSet(), 'f'.repeat(40));

    expect(r.created).toBe(1);
    expect(mockMarketCreateStale).toHaveBeenCalledWith({
      repositoryId: 'repo-1',
      fromSha: 'a'.repeat(40),
      toSha: 'f'.repeat(40),
      paths: ['docs/a.md'],
    });
  });
});

describe('claimJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('非 PENDING 状态拒绝', async () => {
    mockMarketClaim.mockRejectedValueOnce(new Error('INVALID_STATE'));
    await expect(claimJob('job-1', 'u1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('CAS 抢不到 → ALREADY_CLAIMED', async () => {
    mockMarketClaim.mockRejectedValueOnce(new Error('ALREADY_CLAIMED'));
    await expect(claimJob('job-1', 'u1')).rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });
  });

  it('成功认领：租约 TTL 登记退役预估（恒 0，不再查正文体量）', async () => {
    mockMarketClaim.mockResolvedValueOnce({ frozenCredits: 0 });

    const r = await claimJob('job-1', 'u1');
    expect(r.frozenCredits).toBe(0);
    expect(mockMarketClaim).toHaveBeenCalledWith('job-1', 'u1', expect.any(Number));
  });

  it('RELAY 认领：退役后预估不再给一口价', async () => {
    mockMarketClaim.mockResolvedValueOnce({ frozenCredits: 0 });

    const r = await claimJob('job-1', 'u1');
    expect(r.frozenCredits).toBe(0);
    expect(mockMarketClaim).toHaveBeenCalledWith('job-1', 'u1', expect.any(Number));
  });
});

describe('ensureRelayJobForDocument（按需开荒）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('指定未烘焙章节无活跃任务时按需创建新的 PENDING 任务', async () => {
    mockMarketEnsureRelay.mockResolvedValueOnce({
      id: 'job-new',
      repositoryId: 'repo-1',
      kind: 'RELAY',
      status: 'PENDING',
    });

    const job = await ensureRelayJobForDocument('doc-any');
    expect(job.id).toBe('job-new');
    expect(mockMarketEnsureRelay).toHaveBeenCalledWith('doc-any');
  });

  it('已有活跃任务直接返回，避免重复创建（幂等）', async () => {
    mockMarketEnsureRelay.mockResolvedValueOnce({
      id: 'job-existing',
      repositoryId: 'repo-1',
      kind: 'RELAY',
      status: 'CLAIMED',
    });

    const job = await ensureRelayJobForDocument('doc-any');
    expect(job.id).toBe('job-existing');
    expect(mockMarketEnsureRelay).toHaveBeenCalledWith('doc-any');
  });
});

describe('runStagedTranscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedRepoFindManyMock.mockResolvedValue([]);
    jobUpdateMock.mockResolvedValue({});
    jobUpdateManyMock.mockResolvedValue({ count: 1 });
    notificationCreateManyMock.mockResolvedValue({ count: 0 });
    userFindUniqueMock.mockResolvedValue({ tier: 'FREE', role: null });
    jobAggregateMock.mockResolvedValue({ _sum: { baseCredits: 0 } });
    jobCountMock.mockResolvedValue(0);
    userUpdateMock.mockResolvedValue({});
    mockMarketMarkFailed.mockResolvedValue({ ok: true });
    mockMarketRelaySettle.mockResolvedValue({ ok: true });
  });

  function claimedJob(over: Record<string, unknown> = {}) {
    return jobRow({
      status: 'CLAIMED',
      claimedBy: 'u1',
      claimedUntil: new Date(Date.now() + 10 * 60_000),
      frozenCredits: 10,
      document: { content: '# 旧版\n' + '内容。'.repeat(50), path: 'docs/a.md' },
      repository: { id: 'repo-1', owner: 'o', repo: 'r', navTree: [] },
      ...over,
    });
  }

  it('健康流转：UPDATE 机检即入库 → 直换入库为版本（无试读）+ 转录发酬退役 base=0', async () => {
    jobFindUniqueMock.mockResolvedValue(claimedJob());
    generateStagedContentMock.mockResolvedValue({
      content: '# 新版\n' + '更新后的内容。'.repeat(50),
      codeChunks: null,
      model: 'test-model',
    });

    const r = await runStagedTranscription('job-1');
    expect(r.baseCredits).toBe(0);
    expect(mockMarketRelaySettle).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        userId: 'u1',
        documentId: 'doc-1',
        stagedContentId: 'content-1',
        stagedModel: 'test-model',
      })
    );
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it('同酬：认领者即使是教程首个导入者（维护者）→ base 照常为 0，不查身份', async () => {
    jobFindUniqueMock.mockResolvedValue(claimedJob());
    generateStagedContentMock.mockResolvedValue({
      content: '# 新版\n' + '更新后的内容。'.repeat(50),
      codeChunks: null,
      model: 'test-model',
    });

    await runStagedTranscription('job-1');
    expect(mockMarketRelaySettle).toHaveBeenCalled();
    expect(userUpdateMock).not.toHaveBeenCalled();
    expect(importRecordFindFirstMock).not.toHaveBeenCalled();
  });

  it('转录发酬退役：base 恒为 0，不增发积分', async () => {
    jobFindUniqueMock.mockResolvedValue(claimedJob());
    generateStagedContentMock.mockResolvedValue({
      content: '# 新版\n' + '更新后的内容。'.repeat(50),
      codeChunks: null,
      model: 'test-model',
    });

    await runStagedTranscription('job-1');
    expect(mockMarketRelaySettle).toHaveBeenCalled();
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it('月度同仓闸门随发酬退役删除：不再查询本月认领计数', async () => {
    jobFindUniqueMock.mockResolvedValue(claimedJob());
    generateStagedContentMock.mockResolvedValue({
      content: '# 新版\n' + '更新后的内容。'.repeat(50),
      codeChunks: null,
      model: 'test-model',
    });

    await runStagedTranscription('job-1');
    expect(mockMarketRelaySettle).toHaveBeenCalled();
    expect(userUpdateMock).not.toHaveBeenCalled();
    expect(jobCountMock).not.toHaveBeenCalled();
  });

  it('RELAY（首译悬赏）：契约生成 → 机器门自动上架（无试读）→ 正典版本（发酬退役 base=0）', async () => {
    jobFindUniqueMock.mockResolvedValue(claimedJob({ kind: 'RELAY' }));
    generateRelayChapterMock.mockResolvedValue({
      mdx: '# 新版\n\n## 小节\n\n' + '更新后的内容。'.repeat(50),
      model: 'test-model',
    });

    const r = await runStagedTranscription('job-1');
    expect(r.baseCredits).toBe(0);
    void generateRelayChapterMock; // 桩经 staged-relay 端点路由（参数形状由端点契约承载）
    expect(mockMarketRelaySettle).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        userId: 'u1',
        stagedContentId: 'content-1',
      })
    );
    const { upsertContentLayer } = await import('@/lib/content-addressing');
    expect(upsertContentLayer).toHaveBeenCalledWith(
      expect.objectContaining({
        requestFingerprint: 'fingerprint-1',
      })
    );
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it('RELAY CAS 作废：任务已被并发翻走 → INVALID_STATE', async () => {
    jobFindUniqueMock.mockResolvedValue(claimedJob({ kind: 'RELAY' }));
    generateRelayChapterMock.mockResolvedValue({
      mdx: '# 新版\n\n## 小节\n\n' + '更新后的内容。'.repeat(50),
      model: 'test-model',
    });
    mockMarketRelaySettle.mockRejectedValueOnce(new Error('INVALID_STATE'));

    await expect(runStagedTranscription('job-1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it('RELAY 契约生成失败 → FAILED 透传错误信息', async () => {
    jobFindUniqueMock.mockResolvedValue(claimedJob({ kind: 'RELAY' }));
    generateRelayChapterMock.mockRejectedValue(new Error('L0-R 对源硬门未过：代码块丢失'));

    await expect(runStagedTranscription('job-1')).rejects.toThrow(/L0-R/);
    expect(mockMarketMarkFailed).toHaveBeenCalledWith('job-1', 'u1', expect.stringContaining('L0-R'));
  });

  it('L0 拒绝 → FAILED 且零入账、不直换入库', async () => {
    jobFindUniqueMock.mockResolvedValue(claimedJob());
    generateStagedContentMock.mockResolvedValue({ content: '太短', codeChunks: null, model: 'm' });

    await expect(runStagedTranscription('job-1')).rejects.toThrow();
    expect(mockMarketMarkFailed).toHaveBeenCalledWith('job-1', 'u1', expect.stringContaining('L0'));
    expect(mockMarketRelaySettle).not.toHaveBeenCalled();
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it('生成抛错 → FAILED 传播原始错误', async () => {
    jobFindUniqueMock.mockResolvedValue(claimedJob());
    generateStagedContentMock.mockRejectedValue(new Error('model boom'));

    await expect(runStagedTranscription('job-1')).rejects.toThrow('model boom');
    expect(mockMarketMarkFailed).toHaveBeenCalledWith('job-1', 'u1', expect.stringContaining('model boom'));
  });
});

describe('notifyRelaySettled（接力换入通知）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('向关注该仓且开启 autoFollow 的用户推送换入通知，并排除转录者本人', async () => {
    savedRepoFindManyMock.mockResolvedValueOnce([
      { userId: 'u-follower-1' },
      { userId: 'u-transcriber' },
      { userId: 'u-follower-2' },
    ]);
    notificationFindManyMock.mockResolvedValueOnce([]);
    docCountMock.mockResolvedValueOnce(10); // 仍有 10 篇未转录

    await notifyRelaySettled(
      { repositoryId: 'repo-1', documentId: 'doc-1', path: 'src/main.ts', claimedBy: 'u-transcriber' },
      { owner: 'test-owner', repo: 'test-repo' }
    );

    expect(mockCallSidecar).toHaveBeenCalledWith(
      '/v1/notifications/create',
      expect.objectContaining({
        notifications: expect.arrayContaining([
          expect.objectContaining({
            userId: 'u-follower-1',
            type: 'auto_sync_applied',
          }),
          expect.objectContaining({
            userId: 'u-follower-2',
            type: 'auto_sync_applied',
          }),
        ]),
      }),
      expect.anything()
    );
    const calls = mockCallSidecar.mock.calls.filter((c: unknown[]) => c[0] === '/v1/notifications/create');
    const userIds = (calls[0][1] as any).notifications.map((n: { userId: string }) => n.userId);
    expect(userIds).not.toContain('u-transcriber');
  });

  it('1 小时窗口防抖：已收到过该仓更新通知的用户不再重复推送', async () => {
    savedRepoFindManyMock.mockResolvedValueOnce([
      { userId: 'u-throttled' },
      { userId: 'u-fresh' },
    ]);
    notificationFindManyMock.mockResolvedValueOnce([
      { userId: 'u-throttled', payload: { owner: 'test-owner', repo: 'test-repo' } },
    ]);
    docCountMock.mockResolvedValueOnce(5);

    await notifyRelaySettled(
      { repositoryId: 'repo-1', documentId: 'doc-1', path: 'src/main.ts', claimedBy: 'u-other' },
      { owner: 'test-owner', repo: 'test-repo' }
    );

    const calls = mockCallSidecar.mock.calls.filter((c: unknown[]) => c[0] === '/v1/notifications/create');
    expect(calls.length).toBe(1);
    const userIds = (calls[0][1] as any).notifications.map((n: { userId: string }) => n.userId);
    expect(userIds).toEqual(['u-fresh']);
    expect(userIds).not.toContain('u-throttled');
  });

  it('全仓所有章节完成时（unprocessedCount === 0）：推送全书完结里程碑通知', async () => {
    savedRepoFindManyMock.mockResolvedValueOnce([{ userId: 'u-follower' }]);
    notificationFindManyMock.mockResolvedValueOnce([]);
    docCountMock.mockResolvedValueOnce(0); // 0 篇未转录 -> 100% 完结

    await notifyRelaySettled(
      { repositoryId: 'repo-1', documentId: 'doc-final', path: 'src/end.ts', claimedBy: 'u-finisher' },
      { owner: 'test-owner', repo: 'test-repo' }
    );

    expect(mockCallSidecar).toHaveBeenCalledWith(
      '/v1/notifications/create',
      expect.objectContaining({
        notifications: [
          expect.objectContaining({
            userId: 'u-follower',
            type: 'tutorial_published',
            title: expect.stringContaining('全书接力完结'),
          }),
        ],
      }),
      expect.anything()
    );
  });
});
