import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { callSidecar } from '@/lib/sidecar-client';
import {
  IMPORT_JOB_STATUS,
  ImportJobEventSchema,
  ImportJobSnapshotSchema,
  ImportPublicationIntentSchema,
  isTerminalJobStatus,
} from '@/lib/schemas/import-job';
import { computeQueueEtaSeconds } from '@/lib/ingest-queue-eta';
import {
  createImportJob,
  gcFinishedImportJobs,
  getImportJobSnapshot,
  readImportJobSnapshotInternal,
} from '@/lib/jobs/import-job-store';
import { acquireLease, leaseOwner, leaseTtlFromIntervalMs, releaseLease } from '@/lib/scheduler/lease';
import { HAS_SIDECAR, HAS_TEST_DB, createTestUser, uniqueTestTag } from './_test-env';

/**
 * Ingest Lifecycle & Scheduler Lease Temporal Sequence Integration Suite.
 *
 * Supersedes mocked unit tests:
 * - ingest-dedup, ingest-job-fsm, ingest-job-snapshot, ingest-mode-gray-zone,
 *   ingest-queue-eta, ingest-status-route, scheduler-lease.
 */

describe('Ingest Job FSM, Snapshot Schema & Queue ETA Contracts (Non-DB)', () => {
  it('enforces terminal job status boundary and Zod snapshot/event/intent contracts', () => {
    expect(isTerminalJobStatus(IMPORT_JOB_STATUS.COMPLETED)).toBe(true);
    expect(isTerminalJobStatus(IMPORT_JOB_STATUS.FAILED)).toBe(true);
    expect(isTerminalJobStatus(IMPORT_JOB_STATUS.QUEUED)).toBe(false);
    expect(isTerminalJobStatus(IMPORT_JOB_STATUS.RUNNING)).toBe(false);

    const validSnap = ImportJobSnapshotSchema.parse({
      job: {
        id: 'job-1',
        owner: 'octo',
        repo: 'demo',
        branch: 'main',
        edition: '',
        status: IMPORT_JOB_STATUS.RUNNING,
        error: null,
        finishedAt: null,
        lastSeq: 1,
        progressInfo: { step: 'transcribe', progress: 40 },
      },
      events: [
        ImportJobEventSchema.parse({
          seq: 0,
          type: 'log',
          payload: { msg: 'started' },
          createdAt: new Date().toISOString(),
        }),
        ImportJobEventSchema.parse({
          seq: 1,
          type: 'log',
          payload: { msg: 'chunked' },
          createdAt: new Date().toISOString(),
        }),
      ],
      queuePosition: null,
    });
    expect(validSnap.events[1].seq).toBeGreaterThan(validSnap.events[0].seq);

    const intent = ImportPublicationIntentSchema.parse({ kind: 'web-doc', publishRequested: true });
    expect(intent.publishRequested).toBe(true);
    expect(ImportPublicationIntentSchema.parse({}).publishRequested).toBe(false);
  });

  it('computes monotonic queue ETA across QUEUED -> RUNNING -> DONE lifecycle', () => {
    const queuedAhead3 = computeQueueEtaSeconds({
      status: 'QUEUED',
      queuePosition: 3,
      avgJobSeconds: 30,
      savedChunks: 0,
      totalChunks: 10,
      concurrency: 2,
    });
    const queuedAhead1 = computeQueueEtaSeconds({
      status: 'QUEUED',
      queuePosition: 1,
      avgJobSeconds: 30,
      savedChunks: 0,
      totalChunks: 10,
      concurrency: 2,
    });
    const runningMid = computeQueueEtaSeconds({
      status: 'RUNNING',
      queuePosition: null,
      avgJobSeconds: 30,
      savedChunks: 5,
      totalChunks: 10,
      concurrency: 2,
    });
    const done = computeQueueEtaSeconds({
      status: 'DONE',
      queuePosition: null,
      avgJobSeconds: 30,
      savedChunks: 10,
      totalChunks: 10,
      concurrency: 2,
    });

    expect(queuedAhead3).toBe(90); // ceil(3/2)*30 + 30
    expect(queuedAhead1).toBe(60); // ceil(1/2)*30 + 30
    expect(queuedAhead3!).toBeGreaterThan(queuedAhead1!);
    expect(runningMid).toBe(15);
    expect(done).toBeNull();
  });

  it('derives scheduler lease owner & TTL invariants deterministically', () => {
    expect(leaseOwner()).toMatch(/^worker-\d+-[0-9a-f]{8}$/);
    expect(leaseTtlFromIntervalMs(30_000)).toBe(60_000);
  });
});

describe.skipIf(!HAS_TEST_DB || !HAS_SIDECAR)(
  'IngestJob Temporal Lifecycle & Scheduler Lease (Real DB + Sidecar)',
  () => {
    const createdUserIds: string[] = [];
    const createdJobIds: string[] = [];
    const createdRepoIds: string[] = [];
    const createdLeaseKeys: string[] = [];

    afterAll(async () => {
      for (const key of createdLeaseKeys) {
        await prisma.schedulerLease.deleteMany({ where: { key } }).catch(() => {});
      }
      if (createdJobIds.length > 0) {
        await prisma.importJobEvent.deleteMany({ where: { jobId: { in: createdJobIds } } }).catch(() => {});
        await prisma.importJob.deleteMany({ where: { id: { in: createdJobIds } } }).catch(() => {});
      }
      if (createdRepoIds.length > 0) {
        await prisma.creditGrantLedger.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
        await prisma.repository.deleteMany({ where: { id: { in: createdRepoIds } } }).catch(() => {});
      }
      if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
      }
    });

    it('runs full ImportJob sequence: create -> dedup -> CAS transition -> heartbeat stall -> completion & GC protection', async () => {
      const ownerUser = await createTestUser('ingest-u1');
      const otherUser = await createTestUser('ingest-u2');
      createdUserIds.push(ownerUser.id, otherUser.id);

      const ownerName = uniqueTestTag('ing-owner');
      const repoName = uniqueTestTag('ing-repo');
      const branch = ENGINE_CONFIG.defaultBranch;

      // 1. Create job via real Go sidecar single-writer endpoint
      const first = await createImportJob({
        userId: ownerUser.id,
        owner: ownerName,
        repo: repoName,
        branch,
        edition: '',
        params: { kind: 'repo', publishRequested: true },
      });
      expect(first.jobId).toBeTruthy();
      expect(first.deduped).toBe(false);
      createdJobIds.push(first.jobId);

      // 2. Duplicate create while active (QUEUED) must dedup to the exact same jobId
      const dup = await createImportJob({
        userId: ownerUser.id,
        owner: ownerName,
        repo: repoName,
        branch,
        edition: '',
        params: { kind: 'repo', publishRequested: true },
      });
      expect(dup.deduped).toBe(true);
      expect(dup.jobId).toBe(first.jobId);

      // 3. Snapshot visibility isolation: owner sees snapshot, other user gets null
      const ownerSnap0 = await getImportJobSnapshot(first.jobId, ownerUser.id, -1);
      expect(ownerSnap0).not.toBeNull();
      expect(ownerSnap0?.job.status).toBe(IMPORT_JOB_STATUS.QUEUED);
      expect(ownerSnap0?.job.lastSeq).toBe(-1);
      expect(typeof ownerSnap0?.queuePosition).toBe('number');

      const otherSnap = await getImportJobSnapshot(first.jobId, otherUser.id, -1);
      expect(otherSnap).toBeNull();

      // 4. CAS transition QUEUED -> RUNNING (second concurrent CAS must affect 0 rows)
      const casWin = await prisma.$executeRaw`
        UPDATE "ImportJob"
        SET status = 'RUNNING', "startedAt" = NOW(), "lastHeartbeatAt" = NOW()
        WHERE id = ${first.jobId} AND status = 'QUEUED'
      `;
      const casLose = await prisma.$executeRaw`
        UPDATE "ImportJob"
        SET status = 'RUNNING', "startedAt" = NOW(), "lastHeartbeatAt" = NOW()
        WHERE id = ${first.jobId} AND status = 'QUEUED'
      `;
      expect(casWin).toBe(1);
      expect(casLose).toBe(0);

      // 5. Append monotonic events & verify incremental sinceSeq cursor
      await prisma.importJobEvent.createMany({
        data: [
          { jobId: first.jobId, seq: 0, type: 'log', payload: { msg: 'fetch tree' } },
          { jobId: first.jobId, seq: 1, type: 'log', payload: { msg: 'transcribe' } },
        ],
      });
      const incremental = await readImportJobSnapshotInternal(first.jobId, 0);
      expect(incremental?.events).toHaveLength(1);
      expect(incremental?.events[0].seq).toBe(1);
      expect(incremental?.job.lastSeq).toBe(1);

      // 6. Heartbeat stall detection window
      const staleHeartbeat = new Date(Date.now() - 30 * 60_000);
      await prisma.importJob.update({
        where: { id: first.jobId },
        data: { lastHeartbeatAt: staleHeartbeat },
      });
      const stalledRows = await prisma.importJob.findMany({
        where: {
          id: first.jobId,
          status: IMPORT_JOB_STATUS.RUNNING,
          lastHeartbeatAt: { lt: new Date(Date.now() - 10 * 60_000) },
        },
        select: { id: true },
      });
      expect(stalledRows.map((r) => r.id)).toContain(first.jobId);

      // 7. Completion + GC protection while importRewardPending=true vs FAILED job cleanup
      const repoRecord = await prisma.repository.create({
        data: { owner: ownerName, repo: repoName, branch, isPublic: true },
      });
      createdRepoIds.push(repoRecord.id);

      const expiredFinishedAt = new Date(Date.now() - (ENGINE_CONFIG.jobs.finishedJobTtlDays + 5) * 86_400_000);
      await prisma.importJob.update({
        where: { id: first.jobId },
        data: {
          status: IMPORT_JOB_STATUS.COMPLETED,
          finishedAt: expiredFinishedAt,
          result: { repositoryId: repoRecord.id, importRewardPending: true },
        },
      });

      const failedJob = await prisma.importJob.create({
        data: {
          userId: ownerUser.id,
          owner: ownerName,
          repo: `${repoName}-failed`,
          branch,
          edition: '',
          status: IMPORT_JOB_STATUS.FAILED,
          error: 'simulated failure',
          finishedAt: expiredFinishedAt,
          params: {},
        },
      });
      createdJobIds.push(failedJob.id);

      await gcFinishedImportJobs(true);

      // Protected COMPLETED job with pending reward survives GC; expired FAILED job is deleted
      const survivingCompleted = await prisma.importJob.findUnique({ where: { id: first.jobId } });
      const reapedFailed = await prisma.importJob.findUnique({ where: { id: failedJob.id } });
      expect(survivingCompleted).not.toBeNull();
      expect(reapedFailed).toBeNull();
    });

    it('enforces scheduler leader lease mutual exclusion, idempotent renewal, release, and expiry takeover', async () => {
      const leaseKey = uniqueTestTag('lease-it');
      createdLeaseKeys.push(leaseKey);
      const rivalOwner = `rival-${Date.now()}`;

      // 1. Initial acquire succeeds
      expect(await acquireLease(leaseKey, 10_000)).toBe(true);

      // 2. Idempotent renewal by same owner succeeds
      expect(await acquireLease(leaseKey, 10_000)).toBe(true);

      // 3. Rival owner is blocked while lease is active
      const rivalWhileLocked = await callSidecar<{ acquired: boolean }>(
        '/v1/scheduler/lease/acquire',
        { key: leaseKey, ttlMs: 10_000, ownerId: rivalOwner },
        { label: 'test-rival-acquire' }
      );
      expect(rivalWhileLocked.acquired).toBe(false);

      // 4. Release by owner allows rival to acquire immediately
      await releaseLease(leaseKey);
      const rivalAfterRelease = await callSidecar<{ acquired: boolean }>(
        '/v1/scheduler/lease/acquire',
        { key: leaseKey, ttlMs: 10_000, ownerId: rivalOwner },
        { label: 'test-rival-acquire-after-release' }
      );
      expect(rivalAfterRelease.acquired).toBe(true);

      // 5. Force expiry in DB -> original owner can steal expired lease
      await prisma.schedulerLease.update({
        where: { key: leaseKey },
        data: { lockedUntil: new Date(Date.now() - 5_000) },
      });
      expect(await acquireLease(leaseKey, 10_000)).toBe(true);
    });

    it('rejects /api/ingest-status/[owner]/[repo] cleanly for unknown repo', async () => {
      const { GET } = await import('@/app/api/ingest-status/[owner]/[repo]/route');
      const owner = uniqueTestTag('missing-owner');
      const repo = uniqueTestTag('missing-repo');
      const req = new NextRequest(`http://localhost/api/ingest-status/${owner}/${repo}`);
      const res = await GET(req, { params: Promise.resolve({ owner, repo }) });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { success: boolean; code?: string };
      expect(body.success).toBe(false);
      expect(body.code).toBe('REPOSITORY_NOT_FOUND');
    });
  }
);
