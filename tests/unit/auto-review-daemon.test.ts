import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getAutoReviewDaemonEnabled,
  setAutoReviewDaemonEnabled,
  getAutoReviewDaemonStatus,
  runAutoReviewCycle,
} from '@/lib/auto-review/runner';

const mockAdminAuditLogFindFirst = vi.fn();
const mockAdminAuditLogFindMany = vi.fn();
const mockAdminAuditLogCreate = vi.fn();
const mockAdminAuditLogCount = vi.fn();
const mockRepositoryFindMany = vi.fn();
const mockRepositoryFindUnique = vi.fn();
const mockPlatformReviewConfigFindUnique = vi.fn();
const mockCallSidecar = vi.fn().mockResolvedValue({ ok: true });
const mockPublishFanout = vi.fn().mockResolvedValue({ success: true });
const mockReviewTutorialByPlatform = vi.fn();
const mockDecideReview = vi.fn();
const mockQueryRaw = vi.fn();
const mockTransaction = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    adminAuditLog: {
      findFirst: (...args: unknown[]) => mockAdminAuditLogFindFirst(...args),
      findMany: (...args: unknown[]) => mockAdminAuditLogFindMany(...args),
      create: (...args: unknown[]) => mockAdminAuditLogCreate(...args),
      count: (...args: unknown[]) => mockAdminAuditLogCount(...args),
    },
    repository: {
      findMany: (...args: unknown[]) => mockRepositoryFindMany(...args),
      findUnique: (...args: unknown[]) => mockRepositoryFindUnique(...args),
    },
    platformReviewConfig: {
      findUnique: (...args: unknown[]) => mockPlatformReviewConfigFindUnique(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
  },
}));

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => mockCallSidecar(...args),
}));

vi.mock('@/lib/review/publish-fanout', () => ({
  publishFanout: (...args: unknown[]) => mockPublishFanout(...args),
}));

vi.mock('@/lib/review/platform-review', () => ({
  reviewTutorialByPlatform: (...args: unknown[]) => mockReviewTutorialByPlatform(...args),
}));

vi.mock('@/lib/review/decision', () => ({
  decideReview: (...args: unknown[]) => mockDecideReview(...args),
}));

vi.mock('@/lib/credits/import-reward', () => ({
  publicationSnapshot: vi.fn().mockReturnValue({ userId: 'u1', contentHash: 'h1' }),
  getPublicationContent: vi.fn().mockResolvedValue({ ready: true, contentHash: 'h1' }),
  sharePublicationDocuments: vi.fn().mockResolvedValue(true),
}));

describe('AutoReview Daemon & Runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('读取无人值守状态：无记录时默认为 false，有记录时返回最新状态', async () => {
    mockAdminAuditLogFindFirst.mockResolvedValueOnce(null);
    const state1 = await getAutoReviewDaemonEnabled();
    expect(state1).toBe(false);

    mockAdminAuditLogFindFirst.mockResolvedValueOnce({
      detailsJson: { enabled: true },
    });
    const state2 = await getAutoReviewDaemonEnabled();
    expect(state2).toBe(true);
  });

  it('切换无人值守开关：正确写入 AdminAuditLog', async () => {
    mockAdminAuditLogCreate.mockResolvedValueOnce({ id: 'log-1' });
    const res = await setAutoReviewDaemonEnabled(true, 'admin-1', 'admin@example.com');
    expect(res).toBe(true);
    expect(mockAdminAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'AUTO_REVIEW_DAEMON_TOGGLE',
          target: 'AutoReviewDaemon',
          detailsJson: expect.objectContaining({
            enabled: true,
            operatorEmail: 'admin@example.com',
          }),
        }),
      })
    );
  });

  it('未开启无人值守时跳过巡检执行', async () => {
    mockAdminAuditLogFindFirst.mockResolvedValueOnce({
      detailsJson: { enabled: false },
    });
    const result = await runAutoReviewCycle();
    expect(result.scanned).toBe(0);
    expect(result.message).toContain('已停用');
    expect(mockRepositoryFindMany).not.toHaveBeenCalled();
  });

  it('待审队列为空时正常结束巡检并汇报', async () => {
    mockAdminAuditLogFindFirst.mockResolvedValueOnce({
      detailsJson: { enabled: true },
    });
    mockRepositoryFindMany.mockResolvedValueOnce([]);
    const result = await runAutoReviewCycle();
    expect(result.scanned).toBe(0);
    expect(result.message).toContain('待审队列为空');
  });

  it('达标教程执行自动初审并顺利放行公开', async () => {
    mockAdminAuditLogFindFirst.mockResolvedValueOnce({
      detailsJson: { enabled: true },
    });
    mockPlatformReviewConfigFindUnique.mockResolvedValueOnce({
      pipelinePassThreshold: 70,
      llmPassThreshold: 75,
      confidenceThreshold: 0.7,
      enforceQualityGate: false,
    });
    mockRepositoryFindMany.mockResolvedValueOnce([
      {
        id: 'repo-1',
        owner: 'reworkd',
        repo: 'agentgpt',
        reviewPipeline: { total: 85, dimensions: [] },
        reviewLlm: null,
        // ef5d2b4 起巡检以 updatedAt 构造留审跳过签名——桩必须携带
        updatedAt: new Date('2026-11-19T00:00:00Z'),
      },
    ]);
    mockReviewTutorialByPlatform.mockResolvedValueOnce({
      overallScore: 89,
      confidence: 0.9,
      safetyFlag: false,
      archetype: 'SYSTEM_ARCHITECT',
      summary: '优质架构',
      unavailable: false,
    });
    mockDecideReview.mockReturnValueOnce({
      action: 'AUTO_PUBLISH',
      rationale: '通过安全门与质量基准，自动公开',
      scores: { pipeline: 85, llm: 89, confidence: 0.9 },
    });

    mockTransaction.mockImplementationOnce(async (cb: (tx: any) => Promise<any>) => {
      return cb({
        $queryRaw: vi.fn(),
        repository: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'repo-1',
            reviewStatus: 'PENDING',
            reviewPipeline: {
              publication: { userId: 'u1', contentHash: 'h1' },
            },
          }),
        },
        adminAuditLog: { create: vi.fn() },
      });
    });

    const result = await runAutoReviewCycle();
    expect(result.scanned).toBe(1);
    expect(result.approved).toBe(1);
    expect(result.held).toBe(0);
    expect(result.failed).toBe(0);

    // 验证调用了 sidecar 更新 reviewLlm 与公开状态
    expect(mockCallSidecar).toHaveBeenCalledWith(
      '/v1/repos/patch',
      expect.objectContaining({ id: 'repo-1', reviewLlm: expect.any(Object) }),
      expect.any(Object)
    );
    expect(mockPublishFanout).toHaveBeenCalledWith('repo-1', 'admin-approve');

    // 验证审计日志记录 AUTO_REVIEW_APPROVED
    expect(mockAdminAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'AUTO_REVIEW_APPROVED',
          target: 'reworkd/agentgpt',
        }),
      })
    );
  });

  it('获取台账状态指标正常映射', async () => {
    mockAdminAuditLogFindFirst.mockResolvedValueOnce({
      detailsJson: { enabled: true },
    });
    mockAdminAuditLogFindMany.mockResolvedValueOnce([
      {
        id: 'log-1',
        action: 'AUTO_REVIEW_APPROVED',
        target: 'reworkd/agentgpt',
        detailsJson: { pipelineScore: 85, llmScore: 89 },
        createdAt: new Date('2026-11-09T08:00:00Z'),
      },
    ]);
    mockAdminAuditLogCount
      .mockResolvedValueOnce(5) // approved
      .mockResolvedValueOnce(1) // held
      .mockResolvedValueOnce(0); // failed

    const status = await getAutoReviewDaemonStatus();
    expect(status.enabled).toBe(true);
    expect(status.stats.totalApproved).toBe(5);
    expect(status.stats.totalHeld).toBe(1);
    expect(status.logs).toHaveLength(1);
    expect(status.logs[0].target).toBe('reworkd/agentgpt');
  });
});
