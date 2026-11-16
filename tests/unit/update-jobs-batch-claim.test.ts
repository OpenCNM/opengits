import { beforeEach, describe, expect, it, vi } from 'vitest';

const docFindUniqueMock = vi.fn();
const mockJobAuth = vi.fn();
const claimJobMock = vi.fn();
const runStagedTranscriptionMock = vi.fn();
const ensureRelayJobForDocumentMock = vi.fn();
const resolveActiveUserModelMock = vi.fn();
const checkRateLimitMock = vi.fn();
// 2026-10-13 批量认领异步化：路由不再 await runStagedTranscription，改为入队
// 进程内异步执行器（并发受限 + 租约续期）——mock 入队面断言异步语义
const enqueueClaimedTranscriptionMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    document: { findUnique: (...a: unknown[]) => docFindUniqueMock(...a) },
  },
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...a: unknown[]) => checkRateLimitMock(...a),
}));

vi.mock('@/lib/auth-utils', () => ({
  verifyRepoAccessDirect: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: vi.fn().mockResolvedValue({ user: { id: 'u-123' } }),
  getAdminUserHelper: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/observability/errors', () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/engine/market-driver', () => ({
  executeSidecarMarketJobAuthInfo: (...a: unknown[]) => mockJobAuth(...a),
}));

vi.mock('@/lib/ai/user-model-resolver', () => ({
  resolveActiveUserModel: (...a: unknown[]) => resolveActiveUserModelMock(...a),
}));

vi.mock('@/lib/update-market/jobs', () => ({
  claimJob: (...a: unknown[]) => claimJobMock(...a),
  runStagedTranscription: (...a: unknown[]) => runStagedTranscriptionMock(...a),
  ensureRelayJobForDocument: (...a: unknown[]) => ensureRelayJobForDocumentMock(...a),
  UpdateMarketError: class extends Error {
    code?: string;
    constructor(msg: string, code?: string) {
      super(msg);
      this.code = code;
    }
  },
}));

vi.mock('@/lib/update-market/transcription-runner', () => ({
  enqueueClaimedTranscription: (...a: unknown[]) => enqueueClaimedTranscriptionMock(...a),
  getInFlightTranscription: vi.fn(),
  setInFlightTranscription: vi.fn(),
  deleteInFlightTranscription: vi.fn(),
}));

function makeRequest(body: unknown) {
  return {
    url: 'http://localhost/api/update/jobs/batch-claim',
    headers: new Headers({ 'content-type': 'application/json' }),
    cookies: { get: () => undefined },
    json: async () => body,
  } as never;
}

async function callBatchClaim(body: unknown) {
  const { POST } = await import('@/app/api/update/jobs/batch-claim/route');
  return POST(makeRequest(body), {});
}

describe('POST /api/update/jobs/batch-claim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimitMock.mockResolvedValue(true);
    resolveActiveUserModelMock.mockResolvedValue({ id: 'm-1', modelName: 'claude-3-7-sonnet' });
    mockJobAuth.mockResolvedValue({ id: 'job-1', repositoryId: 'repo-1', isPublic: true });
    claimJobMock.mockResolvedValue({ frozenCredits: 10 });
    runStagedTranscriptionMock.mockResolvedValue(undefined);
    // 路由对入队 Promise 串联 .catch()（fire-and-forget 观测）——mock 必须返回 Promise
    enqueueClaimedTranscriptionMock.mockResolvedValue(undefined);
  });

  it('jobIds 为空时抛 400', async () => {
    const res = await callBatchClaim({ jobIds: [] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('请选择至少一个章节任务');
  });

  it('jobIds 超过 MAX_BATCH_SIZE (10) 抛 400', async () => {
    const res = await callBatchClaim({ jobIds: Array.from({ length: 11 }, (_, i) => `j-${i}`) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('最多批量认领 10 个章节');
  });

  it('未配置/激活 BYOK 模型时返回 409 NO_MODEL', async () => {
    resolveActiveUserModelMock.mockResolvedValue(null);
    const res = await callBatchClaim({ jobIds: ['job-1'] });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('请先在设置中配置并激活你的模型');
  });

  it('标准 jobId 批量认领成功（异步转录入队，立即返回）', async () => {
    const res = await callBatchClaim({ jobIds: ['job-1'] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.success).toBe(true);
    expect(body.data.successCount).toBe(1);
    expect(claimJobMock).toHaveBeenCalledWith('job-1', 'u-123');
    // 异步语义：路由只入队不 await 转录（分钟级 LLM 链不再阻塞 HTTP 响应）
    expect(enqueueClaimedTranscriptionMock).toHaveBeenCalledWith('job-1', 'u-123');
    expect(runStagedTranscriptionMock).not.toHaveBeenCalled();
  });

  it('支持传入 documentId 回落并自动创建 relayJob 认领', async () => {
    mockJobAuth.mockRejectedValue(new Error('Job not found'));
    docFindUniqueMock.mockResolvedValue({
      id: 'doc-target',
      repository: { id: 'repo-1', isPublic: true },
    });
    ensureRelayJobForDocumentMock.mockResolvedValue({
      id: 'job-auto-created',
    });

    const res = await callBatchClaim({ jobIds: ['doc-target'] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.success).toBe(true);
    expect(body.data.successCount).toBe(1);
    expect(ensureRelayJobForDocumentMock).toHaveBeenCalledWith('doc-target');
    expect(claimJobMock).toHaveBeenCalledWith('job-auto-created', 'u-123');
    expect(enqueueClaimedTranscriptionMock).toHaveBeenCalledWith('job-auto-created', 'u-123');
  });

  it('第一性原理防线：当 Go sidecar 对 documentId 返回伪装 jobAuth 时，仍坚守优先判定 Document 并按需建单', async () => {
    // 模拟 Go sidecar MarketGetJobAuthInfoDocFallback 的物理现象：把 documentId 当作 id 返回
    mockJobAuth.mockResolvedValue({
      id: 'doc-target',
      repositoryId: 'repo-1',
      kind: 'RELAY',
      status: 'PENDING',
      isPublic: true,
    });
    docFindUniqueMock.mockResolvedValue({
      id: 'doc-target',
      repository: { id: 'repo-1', isPublic: true },
    });
    ensureRelayJobForDocumentMock.mockResolvedValue({
      id: 'job-real-created',
    });

    const res = await callBatchClaim({ jobIds: ['doc-target'] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.success).toBe(true);
    expect(ensureRelayJobForDocumentMock).toHaveBeenCalledWith('doc-target');
    expect(claimJobMock).toHaveBeenCalledWith('job-real-created', 'u-123');
  });
});
