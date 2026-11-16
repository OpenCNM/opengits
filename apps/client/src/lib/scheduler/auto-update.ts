import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { isEmergencyReadOnly } from '@/lib/gateway/policy';
import { acquireLease, leaseTtlFromIntervalMs } from './lease';
import { ACTIVE_JOB_STATUSES } from '@/lib/schemas/update-job';

/**
 * ─────────────────────────────────────────────────────────────
 * 章节级更新市场调度器（软切换模式的自动保鲜，UPDATE_MARKET_ENABLED=1 总闸）。
 *
 * 每轮三件事（全程零 LLM、零删除——内容变更由认领者的 BYOK 转录承担）：
 * 1. 超时清扫：TRIAL 超期默认换入（已投多数反对则否决）；CLAIMED 超租约回池。
 * 2. 过期标记：对 autoSyncEnabled 且红点亮的公开仓做确定性 diff，
 *    为受影响的共享章节建 PENDING 任务（旧内容继续服务）。
 *    结构变更（增删章）不进市场——红点保留，走维护者手动 plan→apply。
 *    全部内容任务结算后（活跃 job 清零）推进 gitSha、清红点。
 * 3. 维护者兜底：PENDING 超过 claimStaleHours 无人认领的任务，由维护者
 *    （最早 ImportRecord 用户，需已配置 BYOK 模型）在月度上限内代为转录。
 *
 * 质量守门：repository.qualityHold=true 的仓整体跳过（绝对底线 re-audit
 * 未过，等维护者人工介入后手动清除标记恢复）。
 * ─────────────────────────────────────────────────────────────
 */

const DEFAULT_INTERVAL_MIN = 60;
const MAX_REPOS_PER_CYCLE = 20;
const MAX_MAINTAINER_FILL_PER_CYCLE = 10;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * 维护者兜底引擎 tick（后续刀 1：投票结算/换入/否决已 Go 进程内直跑
// market_settle.go，本端点仅剩维护者兜底转录——BYOK 注入式 LLM 引擎
// （runStagedTranscription 直注 apiKey），Node 锚定语义）。
 */
export async function runMarketEngineTick(): Promise<void> {
  // 紧急只读熔断：兜底为写路径，全停（策略库故障 fail-open 续跑）
  if (await isEmergencyReadOnly()) {
    console.log('[auto-update] emergency read-only active, skip engine tick');
    return;
  }
  await maintainerBackfill().catch((e) => console.warn('[auto-update] maintainer backfill failed:', e));
}

/** 单轮（Node 自持时钟形态；Go 时钟部署下确定性段由 Go 直跑） */
export async function autoUpdateOnce(): Promise<void> {
  // 紧急只读熔断：跳过本轮（过期标记/建任务/换入等写路径全停；策略库故障 fail-open）
  if (await isEmergencyReadOnly()) {
    console.log('[auto-update] emergency read-only active, skip this cycle');
    return;
  }
  const intervalMin = Number(process.env.AUTO_UPDATE_INTERVAL_MIN) || DEFAULT_INTERVAL_MIN;
  if (!(await acquireLease('auto-update', leaseTtlFromIntervalMs(intervalMin * 60_000)))) {
    console.log('[auto-update] lease held elsewhere, skip this cycle');
    return;
  }

  // 1. 超时清扫（试读倒计时到期与认领租约到期）已收敛为 Go sidecar 单写者
  // 自治（orphan-sweeper 60s 互斥 + auto-update runner 周期直调）——Node 不再
  // 重复触发（2026-11 外围清理）。

  // 2. 过期标记（候选：公开 + 自动同步开启 + 红点亮 + 未被质量守门）
  const repos = await prisma.repository.findMany({
    where: {
      isPublic: true,
      autoSyncEnabled: true,
      hasUpstreamUpdate: true,
      qualityHold: false,
      gitSha: { not: null },
    },
    select: {
      id: true, owner: true, repo: true, branch: true,
      gitSha: true, pendingSyncSha: true, repoProfile: true,
    },
    take: MAX_REPOS_PER_CYCLE,
    orderBy: { upstreamCheckedAt: { sort: 'asc', nulls: 'first' } },
  });

  for (const repo of repos) {
    try {
      await markStaleForRepo(repo);
    } catch (err) {
      console.warn(
        `[auto-update] stale-marking failed for ${repo.owner}/${repo.repo}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // 3. 维护者兜底
  await maintainerBackfill().catch((e) => console.warn('[auto-update] maintainer backfill failed:', e));
}

interface StaleRepoRow {
  id: string;
  owner: string;
  repo: string;
  branch: string;
  gitSha: string | null;
  pendingSyncSha: string | null;
  repoProfile: unknown;
}

async function markStaleForRepo(repo: StaleRepoRow): Promise<void> {
  const { resolveLatestSha, fetchCompareDiff } = await import('@/engine/repo-tarball');
  const toSha = await resolveLatestSha(repo.owner, repo.repo, repo.branch);

  const fromSha = repo.gitSha as string;
  if (fromSha === toSha) {
    // 上游无变化（红点可能是组内其他行写入）→ 清自己的红点
    await prisma.repository
      .update({ where: { id: repo.id }, data: { hasUpstreamUpdate: false, pendingSyncSha: null } })
      .catch((err) => {
        void import('@/lib/observability/errors').then((m) =>
          m.captureError(err, { scope: 'auto-update/clear-reddot', extra: { repositoryId: repo.id } })
        );
      });
    return;
  }

  // 差异基线：优先上一批未结算的同步目标（避免对同区间重复建 job）
  const diffBase = repo.pendingSyncSha ?? fromSha;
  if (diffBase === toSha) {
    // 已建过任务、上游未再前进：等市场结算（活跃清零后推进基线）
    await settleIfAllResolved(repo.id, toSha);
    return;
  }

  const diff = await fetchCompareDiff(repo.owner, repo.repo, diffBase, toSha);
  const { buildUpdateCandidateSet } = await import('@/engine/update-candidate-set');
  const candidateSet = await buildUpdateCandidateSet({
    owner: repo.owner,
    repo: repo.repo,
    branch: repo.branch,
    fromSha: diffBase,
    toSha,
    repositoryId: repo.id,
    docOwnerId: null,
    repoProfile: (repo.repoProfile as Record<string, unknown> | null) ?? null,
    diff,
  });
  if (!candidateSet) {
    throw new Error('candidate set unavailable');
  }

  const { createStaleJobs } = await import('@/lib/update-market/jobs');
  const { created, structural } = await createStaleJobs({ id: repo.id, gitSha: diffBase }, candidateSet, toSha);

  if (structural) {
    // 结构变更（增删章）不进市场：红点保留给维护者手动 plan→apply
    console.log(`[auto-update] ${repo.owner}/${repo.repo} has structural changes, left for manual plan→apply`);
    return;
  }

  if (created > 0) {
    console.log(`[auto-update] ${repo.owner}/${repo.repo} marked ${created} stale chapters (${diffBase.slice(0, 7)}→${toSha.slice(0, 7)})`);
    return;
  }

  // 无需建任务的变更（未命中被转录章节）：若上一批也已结算 → 直接推进基线
  await settleIfAllResolved(repo.id, toSha);
}

/** 活跃 job 清零结算：推进 gitSha、清红点与同步目标 */
async function settleIfAllResolved(repositoryId: string, toSha: string): Promise<void> {
  const activeCount = await prisma.chapterUpdateJob.count({
    where: { repositoryId, status: { in: ACTIVE_JOB_STATUSES } },
  });
  if (activeCount > 0) return;

  await prisma.repository
    .update({
      where: { id: repositoryId },
      data: { gitSha: toSha, pendingSyncSha: null, hasUpstreamUpdate: false },
    })
    .catch((err) => {
      void import('@/lib/observability/errors').then((m) =>
        m.captureError(err, { scope: 'auto-update/settle-baseline', extra: { repositoryId } })
      );
    });
  console.log(`[auto-update] repository ${repositoryId} content-synced to ${toSha.slice(0, 7)}, red dot cleared`);
}

/** 维护者兜底：认领并转录长期无人接单的任务（月度上限内） */
async function maintainerBackfill(): Promise<void> {
  const MARKET = ENGINE_CONFIG.updateMarket;
  const staleBefore = new Date(Date.now() - MARKET.claimStaleHours * 3600_000);

  const staleJobs = await prisma.chapterUpdateJob.findMany({
    where: {
      status: 'PENDING',
      createdAt: { lt: staleBefore },
      repository: { autoSyncEnabled: true, qualityHold: false },
    },
    select: { id: true, repositoryId: true, repository: { select: { owner: true, repo: true } } },
    take: MAX_MAINTAINER_FILL_PER_CYCLE,
    orderBy: { createdAt: 'asc' },
  });
  if (staleJobs.length === 0) return;

  const { resolveMaintainerUserId } = await import('@/lib/repository-maintainer');
  const { resolveActiveUserModel } = await import('@/lib/ai/user-model-resolver');
  const { claimJob } = await import('@/lib/update-market/jobs');
  const { enqueueClaimedTranscription } = await import('@/lib/update-market/transcription-runner');

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const maintainerCache = new Map<string, string | null>();
  for (const job of staleJobs) {
    if (!maintainerCache.has(job.repositoryId)) {
      maintainerCache.set(job.repositoryId, await resolveMaintainerUserId(job.repositoryId).catch(() => null));
    }
    const maintainerId = maintainerCache.get(job.repositoryId) ?? null;
    if (!maintainerId) continue;

    // 月度上限：本月以维护者身份接单的章数（同一维护者跨仓累计）
    const monthlyCount = await prisma.chapterUpdateJob.count({
      where: { claimedBy: maintainerId, claimedUntil: { gte: monthStart }, updatedAt: { gte: monthStart } },
    });
    if (monthlyCount >= MARKET.maintainerMonthlyCap) {
      console.log(`[auto-update] maintainer ${maintainerId.slice(0, 8)} hit monthly cap (${MARKET.maintainerMonthlyCap}), backfill paused`);
      return;
    }

    // 维护者需有激活 BYOK 模型（宁缺毋滥：无模型不兜底）
    const model = await resolveActiveUserModel(maintainerId).catch(() => null);
    if (!model) continue;

    try {
      await claimJob(job.id, maintainerId);
      // 异步执行（性能修复 2026-10-13）：原先串行 await 分钟级转录会把 Go 调度回调
      // 的预算耗尽；入队进程内执行器（并发受限 + 租约续期）后本轮回调立即返回。
      // 失败在内部先落 mark-failed CAS 再 rejection 上抛——此处仅观测记录。
      void enqueueClaimedTranscription(job.id, maintainerId).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[auto-update] maintainer backfill transcription failed for job ${job.id.slice(0, 8)}: ${message.slice(0, 120)}`);
      });
      console.log(`[auto-update] maintainer backfill: ${job.repository.owner}/${job.repository.repo} ${job.id.slice(0, 8)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[auto-update] maintainer backfill failed for job ${job.id.slice(0, 8)}: ${message.slice(0, 120)}`);
    }
  }
}

