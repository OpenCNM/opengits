import { z } from 'zod';
import { prisma } from '@/lib/db';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { checkRateLimit } from '@/lib/rate-limit';
import { executeSidecarMarketJobAuthInfo } from '@/engine/market-driver';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const MAX_BATCH_SIZE = 10;

const bodySchema = z.object({
  jobIds: z
    .array(z.string().trim().min(1))
    .min(1, '请选择至少一个章节任务')
    .max(MAX_BATCH_SIZE, `单次最多批量认领 ${MAX_BATCH_SIZE} 个章节`),
});

export const POST = defineRoute({
  scope: 'POST /api/update/jobs/batch-claim',
  auth: 'user',
  bodySchema,
  handler: async ({ body, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    if (!(await checkRateLimit(`update-claim:${userId}`, 10, 60000))) {
      throw ApiError.tooManyRequests('操作过于频繁');
    }

    const jobIds = body.jobIds;

    const { resolveActiveUserModel } = await import('@/lib/ai/user-model-resolver');
    const model = await resolveActiveUserModel(userId);
    if (!model) {
      throw new ApiError(409, '请先在设置中配置并激活你的模型，才能参与章节转录', { code: 'NO_MODEL' });
    }

    const { claimJob, ensureRelayJobForDocument, UpdateMarketError } = await import('@/lib/update-market/jobs');
    const { enqueueClaimedTranscription } = await import('@/lib/update-market/transcription-runner');

    const results: Array<{
      jobId: string;
      success: boolean;
      queued?: boolean;
      frozenCredits?: number;
      error?: string;
    }> = [];

    for (const jobId of jobIds) {
      try {
        let targetJobId = jobId;
        let repoForAuth: { id: string; isPublic: boolean } | null = null;

        const doc = await prisma.document.findUnique({
          where: { id: jobId },
          select: {
            id: true,
            repository: { select: { id: true, isPublic: true } },
          },
        });

        if (doc?.repository) {
          const relayJob = await ensureRelayJobForDocument(doc.id);
          targetJobId = relayJob.id;
          repoForAuth = doc.repository;
        } else {
          try {
            const jobAuth = await executeSidecarMarketJobAuthInfo(jobId);
            targetJobId = jobAuth.id;
            repoForAuth = { id: jobAuth.repositoryId, isPublic: jobAuth.isPublic };
          } catch (err) {
            console.warn('[batch-claim] sidecar job auth lookup failed:', err);
            repoForAuth = null;
          }
        }

        if (!repoForAuth) {
          results.push({ jobId, success: false, error: '任务或章节不存在' });
          continue;
        }

        if (!(await verifyRepoAccessDirect(repoForAuth, userId))) {
          results.push({ jobId, success: false, error: '无权操作' });
          continue;
        }

        const { frozenCredits } = await claimJob(targetJobId, userId);
        void enqueueClaimedTranscription(targetJobId, userId).catch((err) => {
          console.error(
            `[batch-claim] async transcription failed for job=${targetJobId}:`,
            err instanceof Error ? err.message : err
          );
        });
        results.push({ jobId, success: true, queued: true, frozenCredits });
      } catch (err) {
        const message = err instanceof UpdateMarketError ? err.message : (err as Error)?.message || '认领失败';
        results.push({ jobId, success: false, error: message });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    return ok({
      success: successCount > 0,
      successCount,
      totalCount: jobIds.length,
      results,
    });
  },
});
