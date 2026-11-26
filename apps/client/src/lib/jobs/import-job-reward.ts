import { z } from 'zod';
import { prisma } from '@/lib/db';
import { grantImportReward } from '@/lib/credits/import-reward';
import { publishRepository } from '@/lib/review/publish-repository';
import { ImportPublicationIntentSchema } from '@/lib/schemas/import-job';

const resultSchema = z.object({ repositoryId: z.string().min(1) });

export async function completeImportRewardCallback(jobId: string) {
  const result = await settleCompletedImportReward(jobId);
  await prisma.$executeRaw`UPDATE "ImportJob"
    SET result = jsonb_set(COALESCE(result, '{}'::jsonb), '{importRewardPending}', 'false'::jsonb)
    WHERE id = ${jobId} AND status = 'COMPLETED'`;
  return result;
}

export async function settleCompletedImportReward(jobId: string) {
  const job = await prisma.importJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== 'COMPLETED') return { rewardCredits: 0 };
  const result = resultSchema.safeParse(job.result);
  const params = ImportPublicationIntentSchema.safeParse(job.params);
  if (!result.success || !params.success) return { rewardCredits: 0 };
  const repositoryId = result.data.repositoryId;
  const repository = await prisma.repository.findUnique({ where: { id: repositoryId } });
  if (!repository || repository.owner !== job.owner || repository.repo !== job.repo ||
    repository.branch !== job.branch || repository.edition !== job.edition) return { rewardCredits: 0 };
  if (params.data.kind === 'web-doc' && params.data.publishRequested &&
      repository.reviewStatus !== 'PENDING' && repository.reviewStatus !== 'REJECTED' &&
      !(repository.isPublic && repository.reviewStatus === 'APPROVED')) {
    try {
      const publication = await publishRepository(job.userId, { repoId: repositoryId });
      return { publication };
    } catch (err: any) {
      if (err?.code === 'INCOMPLETE_TRANSCRIPTION' || err?.code === 'NO_LICENSE' || err?.status === 422 || err?.message?.includes('未完成文档转录')) {
        return { publishDeferred: true, reason: err?.message };
      }
      throw err;
    }
  }
  return { rewardCredits: await grantImportReward(repositoryId) };
}
