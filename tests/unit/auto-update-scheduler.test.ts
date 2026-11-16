import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 更新市场调度器单测（软切换模式）：
 * 超时清扫 / 过期标记（建 job、结构变更跳过、清零结算推进基线）/
 * 维护者兜底（BYOK 门 + 月度上限）/ qualityHold 跳过 / 租约互斥。
 */

const repoFindManyMock = vi.fn();
const repoUpdateMock = vi.fn();
const jobCountMock = vi.fn();
const jobFindManyMock = vi.fn();
const leaseUpdateManyMock = vi.fn();
const leaseCreateMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: { findMany: repoFindManyMock, update: repoUpdateMock },
    chapterUpdateJob: { count: jobCountMock, findMany: jobFindManyMock },
  },
}));

const acquireLeaseMock = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/scheduler/lease', () => ({
  acquireLease: (...args: unknown[]) => acquireLeaseMock(...args),
  releaseLease: vi.fn().mockResolvedValue(undefined),
  leaseTtlFromIntervalMs: vi.fn((ms: number) => ms * 2),
}));

const resolveLatestShaMock = vi.fn();
const fetchCompareDiffMock = vi.fn();
vi.mock('@/engine/repo-tarball', () => ({
  resolveLatestSha: (...a: unknown[]) => resolveLatestShaMock(...a),
  fetchCompareDiff: (...a: unknown[]) => fetchCompareDiffMock(...a),
}));

const buildCandidateSetMock = vi.fn();
vi.mock('@/engine/update-candidate-set', () => ({
  buildUpdateCandidateSet: (...a: unknown[]) => buildCandidateSetMock(...a),
}));

const createStaleJobsMock = vi.fn();
const claimJobMock = vi.fn();
const runStagedTranscriptionMock = vi.fn();
vi.mock('@/lib/update-market/jobs', () => ({
  createStaleJobs: (...a: unknown[]) => createStaleJobsMock(...a),
  claimJob: (...a: unknown[]) => claimJobMock(...a),
  runStagedTranscription: (...a: unknown[]) => runStagedTranscriptionMock(...a),
}));

const enqueueClaimedTranscriptionMock = vi.fn();
vi.mock('@/lib/update-market/transcription-runner', () => ({
  enqueueClaimedTranscription: (...a: unknown[]) => enqueueClaimedTranscriptionMock(...a),
}));

const resolveMaintainerMock = vi.fn();
vi.mock('@/lib/repository-maintainer', () => ({
  resolveMaintainerUserId: (...a: unknown[]) => resolveMaintainerMock(...a),
}));

const resolveActiveUserModelMock = vi.fn();
vi.mock('@/lib/ai/user-model-resolver', () => ({
  resolveActiveUserModel: (...a: unknown[]) => resolveActiveUserModelMock(...a),
}));

const OLD_SHA = 'a'.repeat(40);
const NEW_SHA = 'f'.repeat(40);

function repoRow(over: Record<string, unknown> = {}) {
  return {
    id: 'repo-1',
    owner: 'o',
    repo: 'r',
    branch: 'main',
    gitSha: OLD_SHA,
    pendingSyncSha: null,
    repoProfile: {},
    ...over,
  };
}

function candidateSet(chapters: Array<{ path: string; change: 'content' | 'structural' }> = [{ path: 'docs/a.md', change: 'content' }]) {
  return {
    chapters: chapters.map((c) => ({ ...c, title: 'T', oldSummary: null, affectedFiles: [] })),
    unmatchedFiles: [],
    structuralAdds: [],
    structuralRemoves: [],
    diffStats: { added: 0, modified: 1, removed: 0, renamed: 0 },
    hasOldArchive: false,
  };
}

async function runCycle() {
  const mod = await import('@/lib/scheduler/auto-update');
  await mod.autoUpdateOnce();
}

describe('更新市场调度器（软切换模式）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acquireLeaseMock.mockResolvedValue(true);
    leaseUpdateManyMock.mockResolvedValue({ count: 1 });
    leaseCreateMock.mockResolvedValue({});
    repoFindManyMock.mockResolvedValue([repoRow()]);
    repoUpdateMock.mockResolvedValue({});
    jobCountMock.mockResolvedValue(0);
    jobFindManyMock.mockResolvedValue([]);
    resolveLatestShaMock.mockResolvedValue(NEW_SHA);
    fetchCompareDiffMock.mockResolvedValue({
      added: new Set(),
      modified: new Set(['docs/a.md']),
      removed: new Set(),
      renamed: [],
    });
    buildCandidateSetMock.mockResolvedValue(candidateSet());
    createStaleJobsMock.mockResolvedValue({ created: 1, structural: false });
    resolveMaintainerMock.mockResolvedValue('maintainer-1');
    resolveActiveUserModelMock.mockResolvedValue({
      provider: 'p', modelId: 'm', apiKey: 'k', baseURL: 'u', apiFormat: 'openai',
    });
    // backfill 对入队 Promise 串联 .catch()（fire-and-forget 观测）——mock 须返回 Promise
    enqueueClaimedTranscriptionMock.mockResolvedValue(undefined);
  });

  it('租约被持 → 本轮完全跳过', async () => {
    acquireLeaseMock.mockResolvedValue(false);

    await runCycle();

    expect(repoFindManyMock).not.toHaveBeenCalled();
  });

  it('上游无变化（gitSha == latest）→ 清红点与同步目标，不建 job', async () => {
    resolveLatestShaMock.mockResolvedValue(OLD_SHA);

    await runCycle();

    expect(repoUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'repo-1' },
        data: { hasUpstreamUpdate: false, pendingSyncSha: null },
      })
    );
    expect(createStaleJobsMock).not.toHaveBeenCalled();
  });

  it('内容章节变更 → 建 stale job（diff 基线取 gitSha）', async () => {
    await runCycle();

    expect(buildCandidateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ fromSha: OLD_SHA, toSha: NEW_SHA, docOwnerId: null })
    );
    expect(createStaleJobsMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1', gitSha: OLD_SHA }),
      expect.anything(),
      NEW_SHA
    );
    // 建了 job 不推进基线（等市场结算）
    expect(repoUpdateMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ gitSha: NEW_SHA }) })
    );
  });

  it('结构变更（增删章）→ 不进市场，红点保留给手动 plan→apply', async () => {
    buildCandidateSetMock.mockResolvedValue(candidateSet([{ path: 'docs/new.md', change: 'structural' }]));
    createStaleJobsMock.mockResolvedValue({ created: 0, structural: true });

    await runCycle();

    expect(createStaleJobsMock).toHaveBeenCalled();
    expect(repoUpdateMock).not.toHaveBeenCalled();
  });

  it('无新任务且活跃 job 清零 → 推进基线 + 清红点', async () => {
    createStaleJobsMock.mockResolvedValue({ created: 0, structural: false });
    jobCountMock.mockResolvedValue(0);

    await runCycle();

    expect(repoUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'repo-1' },
        data: { gitSha: NEW_SHA, pendingSyncSha: null, hasUpstreamUpdate: false },
      })
    );
  });

  it('无新任务但仍有活跃 job → 等待（不推进基线）', async () => {
    createStaleJobsMock.mockResolvedValue({ created: 0, structural: false });
    jobCountMock.mockResolvedValue(3);

    await runCycle();

    expect(repoUpdateMock).not.toHaveBeenCalled();
  });

  it('pendingSyncSha 已等于上游最新（上批任务在途）→ 只做清零检查', async () => {
    repoFindManyMock.mockResolvedValue([repoRow({ pendingSyncSha: NEW_SHA })]);

    await runCycle();

    expect(fetchCompareDiffMock).not.toHaveBeenCalled();
    expect(buildCandidateSetMock).not.toHaveBeenCalled();
    expect(jobCountMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { repositoryId: 'repo-1', status: { in: ['PENDING', 'CLAIMED', 'TRIAL'] } } })
    );
  });

  it('维护者兜底：长期无人认领 → 认领并转录；无 BYOK 模型则跳过', async () => {
    jobFindManyMock.mockResolvedValue([
      { id: 'job-1', repositoryId: 'repo-1', repository: { owner: 'o', repo: 'r' } },
    ]);
    claimJobMock.mockResolvedValue({ frozenCredits: 10 });
    runStagedTranscriptionMock.mockResolvedValue({ voteDeadline: new Date() });

    await runCycle();

    expect(claimJobMock).toHaveBeenCalledWith('job-1', 'maintainer-1');
    // 2026-10-13 批量认领异步化：backfill 认领后入队异步执行器（不再 await 分钟级转录）
    expect(enqueueClaimedTranscriptionMock).toHaveBeenCalledWith('job-1', 'maintainer-1');
    expect(runStagedTranscriptionMock).not.toHaveBeenCalled();

    // 无模型变体
    vi.clearAllMocks();
    repoFindManyMock.mockResolvedValue([]);
    jobFindManyMock.mockResolvedValue([
      { id: 'job-2', repositoryId: 'repo-1', repository: { owner: 'o', repo: 'r' } },
    ]);
    resolveActiveUserModelMock.mockResolvedValue(null);

    await runCycle();

    expect(claimJobMock).not.toHaveBeenCalled();
  });

  it('维护者月度上限已满 → 停止兜底', async () => {
    createStaleJobsMock.mockResolvedValue({ created: 0, structural: false }); // 走清零结算（消费第一个 count）
    jobFindManyMock.mockResolvedValue([
      { id: 'job-1', repositoryId: 'repo-1', repository: { owner: 'o', repo: 'r' } },
    ]);
    jobCountMock
      .mockResolvedValueOnce(0) // settleIfAllResolved 的活跃计数
      .mockResolvedValueOnce(999); // 月度计数超上限

    await runCycle();

    expect(claimJobMock).not.toHaveBeenCalled();
  });

  it('单仓标记失败不中断他仓', async () => {
    repoFindManyMock.mockResolvedValue([repoRow({ id: 'repo-1' }), repoRow({ id: 'repo-2', owner: 'o2' })]);
    buildCandidateSetMock
      .mockRejectedValueOnce(new Error('diff boom')) // repo-1 失败
      .mockResolvedValueOnce(candidateSet()); // repo-2 正常

    await expect(runCycle()).resolves.toBeUndefined();

    expect(createStaleJobsMock).toHaveBeenCalledTimes(1);
  });
});
