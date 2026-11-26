import { prisma } from '@/lib/db';
import { ignoreBestEffort } from '@/lib/best-effort';
import { ENGINE_CONFIG } from '@/lib/config';
import { callSidecar } from '@/lib/sidecar-client';
import { isEmergencyReadOnly } from '@/lib/gateway/policy';
import {
  CHAPTER_UPDATE_JOB_STATUS as S,
  CHAPTER_UPDATE_JOB_KIND as K,
} from '@/lib/schemas/update-job';
import type { UpdateCandidateSet } from '@/engine/update-candidate-set';
import { l0Gate } from './gate';
import { NOTIFICATION_TYPES } from '@/lib/schemas/notification';

export { l0Gate };

const MARKET = ENGINE_CONFIG.updateMarket;

async function generateStagedContent(
  docId: string,
  opts: { userId?: string | null; model?: string; sourceSha: string }
): Promise<{ content: string; model: string }> {
  return callSidecar<{ content: string; model: string }>(
    '/v1/transcription/staged-generate',
    {
      documentId: docId,
      userId: opts.userId ?? undefined,
      model: opts.model,
      sourceSha: opts.sourceSha,
    },
    { label: 'transcription-staged-generate', timeoutMs: 15 * 60_000 }
  );
}

export async function generateRelayStagedContent(
  docId: string,
  opts: { userId?: string | null; model?: string; sourceSha: string }
): Promise<{ mdx: string; model: string }> {
  return callSidecar<{ mdx: string; model: string }>(
    '/v1/transcription/staged-relay',
    {
      documentId: docId,
      userId: opts.userId ?? undefined,
      model: opts.model,
      sourceSha: opts.sourceSha,
    },
    { label: 'transcription-staged-relay', timeoutMs: 15 * 60_000 }
  );
}

export class UpdateMarketError extends Error {
  constructor(
    message: string,
    public code:
      | 'NOT_FOUND'
      | 'INVALID_STATE'
      | 'ALREADY_CLAIMED'
      | 'EMERGENCY_READONLY'
  ) {
    super(message);
  }
}

function mapSidecarError(err: unknown): never {
  if (err instanceof UpdateMarketError) throw err;
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('ALREADY_CLAIMED')) {
    throw new UpdateMarketError('已被他人认领', 'ALREADY_CLAIMED');
  }
  if (msg.includes('NOT_FOUND')) {
    throw new UpdateMarketError('任务或章节不存在', 'NOT_FOUND');
  }
  if (msg.includes('INVALID_STATE') || msg.includes('409')) {
    throw new UpdateMarketError('任务状态已变化或不在可操作状态', 'INVALID_STATE');
  }
  throw err;
}

export async function createStaleJobs(
  repo: { id: string; gitSha: string | null },
  candidateSet: UpdateCandidateSet,
  toSha: string
): Promise<{ created: number; structural: boolean }> {
  if (candidateSet.chapters.some((c) => c.change === 'structural')) {
    return { created: 0, structural: true };
  }
  const contentPaths = candidateSet.chapters
    .filter((c) => !c.keepExemption)
    .map((c) => c.path);
  if (contentPaths.length === 0) return { created: 0, structural: false };

  const { executeSidecarMarketJobCreateStale } = await import('@/engine/market-driver');
  return await executeSidecarMarketJobCreateStale({
    repositoryId: repo.id,
    fromSha: repo.gitSha ?? '',
    toSha,
    paths: contentPaths,
  });
}

export async function ensureRelayJobForDocument(documentId: string): Promise<{ id: string; repositoryId: string; kind: string; status: string }> {
  if (await isEmergencyReadOnly()) {
    throw new UpdateMarketError('全站维护中，任务认领暂停', 'EMERGENCY_READONLY');
  }
  try {
    const { executeSidecarMarketJobEnsureRelay } = await import('@/engine/market-driver');
    return await executeSidecarMarketJobEnsureRelay(documentId);
  } catch (err) {
    mapSidecarError(err);
  }
}

export async function claimJob(
  jobId: string,
  userId: string
): Promise<{ frozenCredits: number }> {
  if (await isEmergencyReadOnly()) {
    throw new UpdateMarketError('全站维护中，任务认领暂停', 'EMERGENCY_READONLY');
  }
  try {
    const { executeSidecarMarketJobClaim } = await import('@/engine/market-driver');
    const res = await executeSidecarMarketJobClaim(jobId, userId, MARKET.claimTtlMin);
    return res;
  } catch (err) {
    mapSidecarError(err);
  }
}

export async function abandonClaim(
  jobId: string,
  userId: string
): Promise<void> {
  try {
    const { executeSidecarMarketJobRelease } = await import('@/engine/market-driver');
    await executeSidecarMarketJobRelease(jobId, userId);
  } catch (err) {
    mapSidecarError(err);
  }
}

export async function notifyRelaySettled(
  job: { repositoryId: string; documentId: string; path: string; claimedBy: string },
  repo: { owner: string; repo: string }
): Promise<void> {
  try {
    const followers = await prisma.savedRepo.findMany({
      where: { repositoryId: job.repositoryId, autoFollow: true },
      select: { userId: true },
    });
    // Exclude the claimer and debounce repeat notifications within a 1-hour window.
    const candidateIds = [...new Set(followers.map((f) => f.userId).filter((id) => id !== job.claimedBy))];
    if (candidateIds.length === 0) return;

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentNotifs = await prisma.notification.findMany({
      where: {
        userId: { in: candidateIds },
        type: { in: [NOTIFICATION_TYPES.AUTO_SYNC_APPLIED, NOTIFICATION_TYPES.RELAY_OPEN, NOTIFICATION_TYPES.TUTORIAL_PUBLISHED] },
        createdAt: { gte: oneHourAgo },
      },
      select: { userId: true, payload: true },
    });
    const throttledUserIds = new Set(
      recentNotifs
        .filter((n) => {
          let p = n.payload as Record<string, unknown> | null;
          if (typeof p === 'string') {
            try {
              p = JSON.parse(p) as Record<string, unknown>;
            } catch {
              return false;
            }
          }
          return Boolean(p && typeof p === 'object' && p.owner === repo.owner && p.repo === repo.repo);
        })
        .map((n) => n.userId)
    );
    const recipientIds = candidateIds.filter((id) => !throttledUserIds.has(id));
    if (recipientIds.length === 0) return;

    const remainingUnprocessed = await prisma.document.count({
      where: { repositoryId: job.repositoryId, ownerUserId: null, status: 'UNPROCESSED' },
    });

    const isFullyCompleted = remainingUnprocessed === 0;

    const { sendNotifications } = await import('@/lib/notifications/notification-sender');
    if (isFullyCompleted) {
      await sendNotifications(
        recipientIds.map((userId) => ({
          userId,
          type: NOTIFICATION_TYPES.TUTORIAL_PUBLISHED,
          title: `🎉 ${repo.owner}/${repo.repo} 全书接力完结`,
          body: `教程所有章节已由社区全部转录完工！已同步至您的个人项目，欢迎完整阅读。`,
          payload: { owner: repo.owner, repo: repo.repo, path: job.path, completed: true },
        }))
      );
    } else {
      await sendNotifications(
        recipientIds.map((userId) => ({
          userId,
          type: NOTIFICATION_TYPES.AUTO_SYNC_APPLIED,
          title: `${repo.owner}/${repo.repo} 新接力章节已就绪`,
          body: `${job.path} 已由社区志愿者完成转录并换入正典，已自动同步至您的个人项目。`,
          payload: { owner: repo.owner, repo: repo.repo, path: job.path },
        }))
      );
    }
  } catch (err) {
    void import('@/lib/observability/errors').then((m) =>
      m.captureError(err, { scope: 'update-market/notify-relay-settled', extra: { documentId: job.documentId } })
    );
  }
}

export async function runStagedTranscription(jobId: string): Promise<{ baseCredits: number }> {
  const job = await prisma.chapterUpdateJob.findUnique({
    where: { id: jobId },
    include: {
      document: { select: { content: true, path: true, contentRef: { select: { content: true } } } },
      repository: { select: { id: true, owner: true, repo: true, gitSha: true, repoProfile: true } },
    },
  });
  if (!job) throw new UpdateMarketError('任务不存在', 'NOT_FOUND');
  if (job.status !== S.CLAIMED || !job.claimedBy) {
    throw new UpdateMarketError('任务未处于已认领状态', 'INVALID_STATE');
  }
  const claimedBy: string = job.claimedBy;
  if (job.claimedUntil && job.claimedUntil < new Date()) {
    throw new UpdateMarketError('认领已超时，任务已回池', 'INVALID_STATE');
  }

  const targetSha = (job.toSha?.trim() || job.fromSha?.trim() || job.repository?.gitSha?.trim()) ?? '';
  if (!targetSha) {
    throw new UpdateMarketError('任务缺少代码版本 (SHA)', 'INVALID_STATE');
  }

  if (/^[0-9a-f]{7,40}$/i.test(targetSha)) {
    try {
      const { ensureArchive } = await import('@/engine/repo-tarball');
      await ensureArchive(job.repository.owner, job.repository.repo, targetSha);
    } catch {
      // Offline/mock environments may fail archive fetch; Go validates on physical read.
      ignoreBestEffort();
    }
  }

  try {
    let content: string;
    let model: string;
    if (job.kind === K.RELAY) {
      const relay = await generateRelayStagedContent(job.documentId, {
        userId: claimedBy,
        sourceSha: targetSha,
      });
      content = relay.mdx;
      model = relay.model;
    } else {
      const staged = await generateStagedContent(job.documentId, {
        userId: claimedBy,
        sourceSha: targetSha,
      });
      if (!staged.content || staged.content.trim() === '') {
        throw new Error('生成的章节内容为空');
      }
      const gate = l0Gate(staged.content, job.document.contentRef?.content ?? job.document.content);
      if (!gate.passed) {
        throw new Error(`L0 门禁未过：${gate.reason}`);
      }
      content = staged.content;
      model = staged.model;
    }

    const { upsertContentLayer, computeContentHash, computeRequestFingerprint, isDualWriteEnabled } = await import('@/lib/content-addressing');
    const { fingerprintInputsFor } = await import('@/lib/transcription/fingerprint');
    const { toProfileRecord } = await import('@/lib/transcription/types');
    // Hash against targetSha (the actual source revision) rather than current repo HEAD.
    const fingerprint = computeRequestFingerprint(
      fingerprintInputsFor(
        {
          repositoryId: job.repositoryId,
          path: job.path,
          repository: { gitSha: targetSha, repoProfile: toProfileRecord(job.repository?.repoProfile) },
        },
        model,
        {},
      ),
    );
    const contentId = await upsertContentLayer({
      contentHash: computeContentHash(content, ''),
      requestFingerprint: fingerprint,
      content,
      lang: '',
      generationModel: model,
    });

    const { executeSidecarMarketJobRelaySettle } = await import('@/engine/market-driver');
    await executeSidecarMarketJobRelaySettle({
      jobId: job.id,
      userId: claimedBy,
      documentId: job.documentId,
      repositoryId: job.repositoryId,
      stagedContentId: contentId,
      stagedModel: model,
      toSha: targetSha,
      dualWrite: isDualWriteEnabled(),
    });

    void postSwap(
      { repositoryId: job.repositoryId, documentId: job.documentId, path: job.path, stagedContentId: contentId },
      content
    ).catch((e) => {
      void import('@/lib/observability/errors').then((m) =>
        m.captureError(e, { scope: 'update-market/relay-post-swap', extra: { jobId: job.id } })
      );
    });

    void notifyRelaySettled(
      { repositoryId: job.repositoryId, documentId: job.documentId, path: job.path, claimedBy },
      { owner: job.repository.owner, repo: job.repository.repo }
    ).catch((e) => {
      void import('@/lib/observability/errors').then((m) =>
        m.captureError(e, { scope: 'update-market/relay-notify-settled', extra: { jobId: job.id } })
      );
    });

    return { baseCredits: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { executeSidecarMarketJobMarkFailed } = await import('@/engine/market-driver');
    await executeSidecarMarketJobMarkFailed(job.id, claimedBy, message).catch((writeErr) => {
      void import('@/lib/observability/errors').then((m) =>
        m.captureError(writeErr, { scope: 'update-market/failed-write', extra: { jobId: job.id } })
      );
    });
    mapSidecarError(err);
  }
}

export async function postSwap(
  job: { repositoryId: string; documentId: string; path: string; stagedContentId: string | null },
  content: string
): Promise<void> {
  if (content) {
    const { syncDocumentKnowledgeGraph } = await import('@/lib/mcp/document-graph-sync');
    await syncDocumentKnowledgeGraph(job.repositoryId, job.documentId, job.path, content);
  }

  const res = await callSidecar<{ ok: boolean; autoSwapCount?: number }>(
    '/v1/repos/increment',
    {
      id: job.repositoryId,
      autoSwapCount: 1,
    },
    { label: 'update-market-increment-swap-count' }
  );
  const autoSwapCount = res?.autoSwapCount ?? 0;
  if (autoSwapCount > 0 && autoSwapCount % MARKET.auditEveryNSwaps === 0) {
    try {
      const audit = await callSidecar<{ ok: boolean; score: number; floor: number; held: boolean }>(
        '/v1/market/repo-audit',
        { repositoryId: job.repositoryId },
        { label: 'update-market-repo-audit' }
      );
      if (audit.held) {
        console.warn(`[update-market] quality hold: pipeline ${audit.score} < floor ${audit.floor}`);
      }
    } catch (err) {
      console.warn('[update-market] re-audit failed (skip this round):', err);
    }
  }
}
