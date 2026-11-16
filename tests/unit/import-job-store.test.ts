import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ImportJob 状态机单测：CAS 认领 / 心跳过期 reap / QUEUED 卡死 reap / 事件写入器。
 * prisma 全量 mock（参照 tests/unit/document-processor.test.ts 的手写 vi.mock 风格）。
 */

const updateManyMock = vi.fn();
const createManyMock = vi.fn();
const jobUpdateMock = vi.fn();
const findUniqueMock = vi.fn();
const findManyMock = vi.fn();
const aggregateMock = vi.fn();
const deleteManyMock = vi.fn();
const createMock = vi.fn();
const queryRawMock = vi.fn();
const executeRawMock = vi.fn().mockResolvedValue(0);
const callSidecarMock = vi.fn().mockResolvedValue({ ok: true, count: 0 });

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRawMock(...(args as [TemplateStringsArray, ...unknown[]])),
    $executeRaw: executeRawMock,
    importJob: {
      create: createMock,
      update: jobUpdateMock,
      updateMany: updateManyMock,
      findUnique: findUniqueMock,
      findMany: findManyMock,
      count: vi.fn().mockResolvedValue(0),
      deleteMany: deleteManyMock,
      aggregate: aggregateMock,
    },
    importJobEvent: {
      createMany: createManyMock,
      findMany: findManyMock,
      findFirst: vi.fn(),
      aggregate: aggregateMock,
    },
  },
}));

// ENGINE_CONFIG.jobs 用真实配置（默认值），reap 阈值 60s
vi.useFakeTimers();

describe('ImportJob 状态机', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // GC 为 fire-and-forget：默认返回安全值，避免未处理拒绝
    deleteManyMock.mockResolvedValue({ count: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers();
  });


  it('getImportJobSnapshot：归属不符返回 null（越权防护）', async () => {
    const { getImportJobSnapshot } = await import('@/lib/jobs/import-job-store');
    updateManyMock.mockResolvedValue({ count: 0 });
    findUniqueMock.mockResolvedValue({
      id: 'job1', userId: 'userA', owner: 'o', repo: 'r', branch: 'main',
      edition: '', status: 'RUNNING', error: null, finishedAt: null,
    });
    findManyMock.mockResolvedValue([]);
    aggregateMock.mockResolvedValue({ _max: { seq: -1 } });
    await expect(getImportJobSnapshot('job1', 'userB', -1)).resolves.toBeNull();
  });

  it('getImportJobSnapshot：增量事件按 since 过滤 + lastSeq 汇报', async () => {
    const { getImportJobSnapshot } = await import('@/lib/jobs/import-job-store');
    updateManyMock.mockResolvedValue({ count: 0 });
    findUniqueMock.mockResolvedValue({
      id: 'job1', userId: 'userA', owner: 'o', repo: 'r', branch: 'main',
      edition: '', status: 'RUNNING', error: null, finishedAt: null,
    });
    findManyMock.mockResolvedValue([
      { seq: 3, type: 'log', payload: { message: 'x' }, createdAt: new Date() },
      { seq: 4, type: 'log', payload: { message: 'y' }, createdAt: new Date() },
    ]);
    aggregateMock.mockResolvedValue({ _max: { seq: 4 } });
    const snap = await getImportJobSnapshot('job1', 'userA', 2);
    expect(snap?.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(snap?.job.lastSeq).toBe(4);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { jobId: 'job1', seq: { gt: 2 } } })
    );
  });

  it('getImportJobSnapshot：QUEUED 任务返回排队位（前面还有几个）', async () => {
    vi.useRealTimers();
    const { getImportJobSnapshot } = await import('@/lib/jobs/import-job-store');
    const now = new Date();
    updateManyMock.mockResolvedValue({ count: 0 });
    findUniqueMock.mockResolvedValue({
      id: 'jobQ', userId: 'userA', owner: 'o', repo: 'r', branch: 'main',
      edition: '', status: 'QUEUED', error: null, finishedAt: null, createdAt: now,
    });
    // count 被排队位查询消费；aggregate 被事件 lastSeq 查询消费
    aggregateMock.mockResolvedValue({ _max: { seq: -1 } });
    const prismaMod = await import('@/lib/db');
    (prismaMod.prisma.importJob as any).count = vi.fn().mockResolvedValue(5);
    findManyMock.mockResolvedValue([]);
    const snap = await getImportJobSnapshot('jobQ', 'userA', -1);
    expect(snap?.queuePosition).toBe(5);
    vi.useFakeTimers();
  });

  it('GC retains pending callbacks and unpaid completed import proof beyond TTL', async () => {
    const { gcFinishedImportJobs } = await import('@/lib/jobs/import-job-store');
    executeRawMock.mockResolvedValueOnce(2);
    expect(await gcFinishedImportJobs(true)).toBe(2);
    const [strings, cutoff, failed, completed] = executeRawMock.mock.calls.at(-1)!;
    const sql = strings.join('?');
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBeLessThan(Date.now());
    expect([failed, completed]).toEqual(['FAILED', 'COMPLETED']);
    expect(sql).toContain('job."finishedAt" <');
    expect(sql).toContain("(job.result->>'importRewardPending') IS DISTINCT FROM 'true'");
    expect(sql).toContain("NULLIF(job.result->>'repositoryId', '') IS NULL");
    expect(sql).toContain('OR EXISTS');
    expect(sql).toContain('ledger."repositoryId" = job.result->>\'repositoryId\'');
    expect(sql).toContain("ledger.source = 'IMPORT_REWARD'");
  });

  it('getImportJobSnapshot：RUNNING 任务 queuePosition 为 null（不查排队计数）', async () => {
    vi.useRealTimers();
    const { getImportJobSnapshot } = await import('@/lib/jobs/import-job-store');
    updateManyMock.mockResolvedValue({ count: 0 });
    findUniqueMock.mockResolvedValue({
      id: 'jobR', userId: 'userA', owner: 'o', repo: 'r', branch: 'main',
      edition: '', status: 'RUNNING', error: null, finishedAt: null, createdAt: new Date(),
    });
    findManyMock.mockResolvedValue([]);
    aggregateMock.mockResolvedValue({ _max: { seq: 0 } });
    const snap = await getImportJobSnapshot('jobR', 'userA', -1);
    expect(snap?.queuePosition).toBeNull();
    vi.useFakeTimers();
  });

  // 调度器段（claim/pump/WORKER_INPROCESS 门控）已随 Node in-process 执行器
  // 双轨退役删除（2026-10 收口）：认领与泵的 SSOT 在 Go jobs Runner
  // （internal/jobs/runner.go，SKIP LOCKED + tick/pumpCh），Node 侧仅存
  // scheduleImportJob 薄封装唤醒 /v1/jobs/enqueue-pump。
});
