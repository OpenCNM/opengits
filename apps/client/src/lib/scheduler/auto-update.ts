import { ignoreBestEffort } from '@/lib/best-effort';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { isEmergencyReadOnly } from '@/lib/gateway/policy';
import { acquireLease, leaseTtlFromIntervalMs } from './lease';
import { ACTIVE_JOB_STATUSES } from '@/lib/schemas/update-job';

const DEFAULT_INTERVAL_MIN = 60;
const MAX_REPOS_PER_CYCLE = 20;
const MAX_MAINTAINER_FILL_PER_CYCLE = 10;

let timer: ReturnType<typeof setInterval> | null = null;

export async function runMarketEngineTick(): Promise<void> {
  if (await isEmergencyReadOnly()) {
    console.log('[auto-update] emergency read-only active, skip engine tick');
    return;
  }
  await maintainerBackfill().catch((e) => console.warn('[auto-update] maintainer backfill failed:', e));
}

// Check emergency read-only before acquiring a lease to avoid idle sidecar contention.
export async function autoUpdateOnce(): Promise<void> {
  if (await isEmergencyReadOnly()) {
    console.log('[auto-update] emergency read-only active, skip this cycle');
    return;
  }
  const intervalMin = Number(process.env.AUTO_UPDATE_INTERVAL_MIN) || DEFAULT_INTERVAL_MIN;
  if (!(await acquireLease('auto-update', leaseTtlFromIntervalMs(intervalMin * 60_000)))) {
    console.log('[auto-update] lease held elsewhere, skip this cycle');
    return;
  }

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
    await prisma.repository
      .update({ where: { id: repo.id }, data: { hasUpstreamUpdate: false, pendingSyncSha: null } })
      .catch((err) => {
        void import('@/lib/observability/errors').then((m) =>
          m.captureError(err, { scope: 'auto-update/clear-reddot', extra: { repositoryId: repo.id } })
        );
      });
    return;
  }

  const diffBase = repo.pendingSyncSha ?? fromSha;
  if (diffBase === toSha) {
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
    console.log(`[auto-update] ${repo.owner}/${repo.repo} has structural changes, left for manual plan→apply`);
    return;
  }

  if (created > 0) {
    console.log(`[auto-update] ${repo.owner}/${repo.repo} marked ${created} stale chapters (${diffBase.slice(0, 7)}→${toSha.slice(0, 7)})`);
    return;
  }

  await settleIfAllResolved(repo.id, toSha);
}

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
      maintainerCache.set(
        job.repositoryId,
        await resolveMaintainerUserId(job.repositoryId).catch(() => {
          ignoreBestEffort();
          return null;
        })
      );
    }
    const maintainerId = maintainerCache.get(job.repositoryId) ?? null;
    if (!maintainerId) continue;

    const monthlyCount = await prisma.chapterUpdateJob.count({
      where: { claimedBy: maintainerId, claimedUntil: { gte: monthStart }, updatedAt: { gte: monthStart } },
    });
    if (monthlyCount >= MARKET.maintainerMonthlyCap) {
      console.log(`[auto-update] maintainer ${maintainerId.slice(0, 8)} hit monthly cap (${MARKET.maintainerMonthlyCap}), backfill paused`);
      return;
    }

    const model = await resolveActiveUserModel(maintainerId).catch(() => {
      ignoreBestEffort();
      return null;
    });
    if (!model) continue;

    try {
      await claimJob(job.id, maintainerId);
      // Dispatch transcription async so slow jobs do not exhaust the scheduler cycle.
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

