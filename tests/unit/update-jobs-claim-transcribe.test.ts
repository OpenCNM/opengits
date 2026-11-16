import { beforeEach, describe, expect, it, vi } from 'vitest';

const docFindUniqueMock = vi.fn();
const mockJobAuth = vi.fn();
const claimJobMock = vi.fn();
const runStagedTranscriptionMock = vi.fn();
const ensureRelayJobForDocumentMock = vi.fn();
const resolveActiveUserModelMock = vi.fn();
const checkRateLimitMock = vi.fn();

const chapterUpdateJobFindFirstMock = vi.fn().mockResolvedValue(null);
const chapterUpdateJobFindUniqueMock = vi.fn().mockResolvedValue(null);

vi.mock('@/lib/db', () => ({
  prisma: {
    document: { findUnique: (...a: unknown[]) => docFindUniqueMock(...a) },
    tokenUsageLog: { findFirst: vi.fn().mockResolvedValue(null) },
    chapterUpdateJob: {
      findUnique: (...a: unknown[]) => chapterUpdateJobFindUniqueMock(...a),
      findFirst: (...a: unknown[]) => chapterUpdateJobFindFirstMock(...a),
    },
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

const chargeShelfFeeAndSaveMock = vi.fn().mockResolvedValue({ ok: true, fee: 0, signupGift: 0, alreadySaved: false });

vi.mock('@/lib/credits/shelf-fee', () => ({
  chargeShelfFeeAndSave: (...a: unknown[]) => chargeShelfFeeAndSaveMock(...a),
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

function makeRequest(id: string) {
  return {
    url: `http://localhost/api/update/jobs/${id}/claim-transcribe`,
    headers: new Headers({ 'content-type': 'application/json' }),
    cookies: { get: () => undefined },
    json: async () => ({}),
  } as unknown as Request;
}

describe('POST /api/update/jobs/[id]/claim-transcribe (第一性原理硬化)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimitMock.mockResolvedValue(true);
    resolveActiveUserModelMock.mockResolvedValue({ provider: 'openai', model: 'gpt-4o' });
    claimJobMock.mockResolvedValue({ frozenCredits: 0 });
    runStagedTranscriptionMock.mockResolvedValue({ baseCredits: 0 });
  });

  it('传入标准 jobId 时直接执行认领与转录', async () => {
    docFindUniqueMock.mockResolvedValue(null);
    mockJobAuth.mockResolvedValue({
      id: 'job-real-uuid',
      repositoryId: 'repo-1',
      kind: 'RELAY',
      status: 'PENDING',
      isPublic: true,
    });

    const { POST } = await import('@/app/api/update/jobs/[id]/claim-transcribe/route');
    const res = await POST(makeRequest('job-real-uuid'), { params: Promise.resolve({ id: 'job-real-uuid' }) });
    expect(res.status).toBe(200);
    expect(claimJobMock).toHaveBeenCalledWith('job-real-uuid', 'u-123');
    expect(runStagedTranscriptionMock).toHaveBeenCalledWith('job-real-uuid');
    expect(chargeShelfFeeAndSaveMock).toHaveBeenCalledWith('u-123', 'repo-1', true);
  });

  it('第一性原理：当传入 documentId 时，无论 Go sidecar 是否返回伪装 jobAuth，均优先判定 Document 并按需建单', async () => {
    // 模拟生产物理事实：Go sidecar 对 documentId 返回伪装 jobAuth，但物理实体是 Document
    mockJobAuth.mockResolvedValue({
      id: 'doc-target-uuid',
      repositoryId: 'repo-1',
      kind: 'RELAY',
      status: 'PENDING',
      isPublic: true,
    });
    docFindUniqueMock.mockResolvedValue({
      id: 'doc-target-uuid',
      path: 'docs/index.md',
      repositoryId: 'repo-1',
      repository: { id: 'repo-1', isPublic: true, relayEnabled: true, gitSha: 'sha-1' },
    });
    ensureRelayJobForDocumentMock.mockResolvedValue({
      id: 'job-created-by-relay',
      repositoryId: 'repo-1',
      kind: 'RELAY',
      status: 'PENDING',
    });

    const { POST } = await import('@/app/api/update/jobs/[id]/claim-transcribe/route');
    const res = await POST(makeRequest('doc-target-uuid'), { params: Promise.resolve({ id: 'doc-target-uuid' }) });
    expect(res.status).toBe(200);

    // 关键断言：必须调用 ensureRelayJobForDocument 换取真正的 Job ID，并以此 Job ID 认领
    expect(ensureRelayJobForDocumentMock).toHaveBeenCalledWith('doc-target-uuid');
    expect(claimJobMock).toHaveBeenCalledWith('job-created-by-relay', 'u-123');
    expect(runStagedTranscriptionMock).toHaveBeenCalledWith('job-created-by-relay');
    expect(chargeShelfFeeAndSaveMock).toHaveBeenCalledWith('u-123', 'repo-1', true);
  });

  it('任务和章节均不存在时抛出 404', async () => {
    docFindUniqueMock.mockResolvedValue(null);
    mockJobAuth.mockRejectedValue(new Error('Job not found'));

    const { POST } = await import('@/app/api/update/jobs/[id]/claim-transcribe/route');
    const res = await POST(makeRequest('non-existent'), { params: Promise.resolve({ id: 'non-existent' }) });
    expect(res.status).toBe(404);
  });

  it('第一性原理幂等：当任务已 SWAPPED 或文档已 PROCESSED 时，重复 POST 不调 claimJob 且安全返回落库结果（杜绝 409）', async () => {
    mockJobAuth.mockResolvedValue({
      id: 'job-settled',
      repositoryId: 'repo-1',
      kind: 'RELAY',
      status: 'SWAPPED',
      isPublic: true,
    });
    chapterUpdateJobFindUniqueMock.mockResolvedValue({
      id: 'job-settled',
      status: 'SWAPPED',
      documentId: 'doc-settled',
      document: { id: 'doc-settled', status: 'PROCESSED' },
    });
    docFindUniqueMock.mockResolvedValue({
      id: 'doc-settled',
      path: 'docs/done.md',
      title: '已完成章节',
      status: 'PROCESSED',
      generationModel: 'qwen3.8-max',
      repository: { id: 'repo-1', isPublic: true, owner: 'owner', repo: 'repo' },
      outlineNodes: [{ title: '已完成章节', chapter: { title: '第一章' } }],
    });

    const { POST } = await import('@/app/api/update/jobs/[id]/claim-transcribe/route');
    const res = await POST(makeRequest('job-settled'), { params: Promise.resolve({ id: 'job-settled' }) });
    expect(res.status).toBe(200);
    // 绝不可重复调用 claimJob（否则在 Go 侧会因非 PENDING 报错 409）
    expect(claimJobMock).not.toHaveBeenCalled();
    const json = await res.json();
    expect(json.data.title).toBe('已完成章节');
  });

  describe('GET /api/update/jobs/[id]/claim-transcribe (物理事实轮询与对齐)', () => {
    it('当 Document 已落库 PROCESSED 时返回 completed 状态', async () => {
      docFindUniqueMock.mockResolvedValue({
        id: 'doc-done',
        path: 'guide/install.md',
        title: '安装指南',
        status: 'PROCESSED',
        generationModel: 'gpt-4o',
        repository: { id: 'repo-1', isPublic: true, owner: 'vercel', repo: 'next.js' },
        outlineNodes: [{ title: '安装指南', chapter: { title: '第一章 快速上手' } }],
      });

      const { GET } = await import('@/app/api/update/jobs/[id]/claim-transcribe/route');
      const res = await GET(makeRequest('doc-done'), { params: Promise.resolve({ id: 'doc-done' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe('completed');
      expect(json.data.result.title).toBe('安装指南');
      expect(json.data.result.owner).toBe('vercel');
    });

    it('当 ChapterUpdateJob 处于 CLAIMED 租约期内时返回 running 状态', async () => {
      docFindUniqueMock.mockResolvedValue({
        id: 'doc-running',
        path: 'guide/arch.md',
        title: '架构设计',
        status: 'UNPROCESSED',
        repository: { id: 'repo-1', isPublic: true, owner: 'vercel', repo: 'next.js' },
      });
      chapterUpdateJobFindFirstMock.mockResolvedValue({
        id: 'job-1',
        status: 'CLAIMED',
        claimedBy: 'u-123',
        claimedUntil: new Date(Date.now() + 60000),
      });

      const { GET } = await import('@/app/api/update/jobs/[id]/claim-transcribe/route');
      const res = await GET(makeRequest('doc-running'), { params: Promise.resolve({ id: 'doc-running' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe('running');
    });

    it('当 ChapterUpdateJob 租约过期时返回 failed 状态', async () => {
      docFindUniqueMock.mockResolvedValue({
        id: 'doc-expired',
        path: 'guide/arch.md',
        title: '架构设计',
        status: 'UNPROCESSED',
        repository: { id: 'repo-1', isPublic: true, owner: 'vercel', repo: 'next.js' },
      });
      chapterUpdateJobFindFirstMock.mockResolvedValue({
        id: 'job-1',
        status: 'CLAIMED',
        claimedBy: 'u-123',
        claimedUntil: new Date(Date.now() - 1000), // 已过期
      });

      const { GET } = await import('@/app/api/update/jobs/[id]/claim-transcribe/route');
      const res = await GET(makeRequest('doc-expired'), { params: Promise.resolve({ id: 'doc-expired' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe('failed');
      expect(json.data.error).toContain('超时');
    });
  });
});
