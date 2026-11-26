import { ignoreBestEffort } from '@/lib/best-effort';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { isEmergencyReadOnly } from '@/lib/gateway/policy';
import { callSidecar } from '@/lib/sidecar-client';
import {
  IMPORT_JOB_STATUS,
  isTerminalJobStatus,
  type ImportJobEventDTO,
  type ImportJobSnapshotDTO,
} from '@/lib/schemas/import-job';

export interface CreateImportJobInput {
  userId: string;
  owner: string;
  repo: string;
  branch: string;
  edition: string;
  params: Record<string, unknown>;
}

export async function createImportJob(
  input: CreateImportJobInput
): Promise<{ jobId: string; deduped: boolean }> {
  const res = await callSidecar<{ id: string; deduped?: boolean }>(
    '/v1/jobs/create',
    {
      owner: input.owner,
      repo: input.repo,
      branch: input.branch,
      edition: input.edition,
      userId: input.userId || null,
      params: input.params,
    },
    { label: 'create-import-job', timeoutMs: 15_000 }
  );
  return { jobId: res.id, deduped: !!res.deduped };
}

let lastGcAt = 0;
export async function gcFinishedImportJobs(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastGcAt < 10 * 60 * 1000) return 0;
  lastGcAt = now;
  const ttlBefore = new Date(now - ENGINE_CONFIG.jobs.finishedJobTtlDays * 24 * 60 * 60 * 1000);
  return prisma.$executeRaw`
    DELETE FROM "ImportJob" AS job
    WHERE job."finishedAt" < ${ttlBefore}
      AND (
        job.status = ${IMPORT_JOB_STATUS.FAILED}
        OR (
          job.status = ${IMPORT_JOB_STATUS.COMPLETED}
          AND (job.result->>'importRewardPending') IS DISTINCT FROM 'true'
          AND (
            NULLIF(job.result->>'repositoryId', '') IS NULL
            OR EXISTS (
              SELECT 1 FROM "CreditGrantLedger" AS ledger
              WHERE ledger."repositoryId" = job.result->>'repositoryId'
                AND ledger.source = 'IMPORT_REWARD'
            )
          )
        )
      )
  `;
}

export async function readImportJobSnapshotInternal(
  jobId: string,
  sinceSeq = -1
): Promise<(ImportJobSnapshotDTO & { ownerUserId: string }) | null> {
  const job = await prisma.importJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      userId: true,
      owner: true,
      repo: true,
      branch: true,
      edition: true,
      status: true,
      error: true,
      finishedAt: true,
      createdAt: true,
      options: true,
    },
  });
  if (!job) return null;

  const rawProgress = (job.options as Record<string, unknown> | null)?.progressInfo;
  const progressInfo =
    rawProgress && typeof rawProgress === 'object'
      ? (rawProgress as Record<string, unknown>)
      : null;

  let queuePosition: number | null = null;
  if (job.status === IMPORT_JOB_STATUS.QUEUED) {
    queuePosition = await prisma.importJob.count({
      where: {
        status: IMPORT_JOB_STATUS.QUEUED,
        createdAt: { lt: job.createdAt },
      },
    });
  }

  const events = await prisma.importJobEvent.findMany({
    where: { jobId, seq: { gt: sinceSeq } },
    orderBy: { seq: 'asc' },
    take: 500,
  });

  const lastSeqAgg = await prisma.importJobEvent.aggregate({
    where: { jobId },
    _max: { seq: true },
  });

  return {
    job: {
      id: job.id,
      owner: job.owner,
      repo: job.repo,
      branch: job.branch,
      edition: job.edition,
      status: job.status,
      error: job.error,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      lastSeq: lastSeqAgg._max.seq ?? -1,
      progressInfo,
    },
    ownerUserId: job.userId,
    events: events.map(
      (e): ImportJobEventDTO => ({
        seq: e.seq,
        type: e.type as ImportJobEventDTO['type'],
        payload: (e.payload as Record<string, unknown> | null) ?? null,
        createdAt: e.createdAt.toISOString(),
      })
    ),
    queuePosition,
  };
}

export async function getImportJobSnapshot(
  jobId: string,
  viewerUserId: string,
  sinceSeq = -1
): Promise<ImportJobSnapshotDTO | null> {
  gcFinishedImportJobs().catch((err) => {
    void import('@/lib/observability/errors').then((m) =>
      m.captureError(err, { scope: 'import-job-store/gc' })
    );
  });

  const snap = await readImportJobSnapshotInternal(jobId, sinceSeq);
  if (!snap || snap.ownerUserId !== viewerUserId) return null;

  const { ownerUserId: _ownerUserId, ...rest } = snap;
  void _ownerUserId;
  return rest;
}

export { isTerminalJobStatus };

export async function scheduleImportJob(jobId: string): Promise<void> {
  void jobId;
  try {
    await callSidecar('/v1/jobs/enqueue-pump', {}, { label: 'jobs-enqueue-pump', timeoutMs: 3_000 });
  } catch {
    ignoreBestEffort();
  }
}
