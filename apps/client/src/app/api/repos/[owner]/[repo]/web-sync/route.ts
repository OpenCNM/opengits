import { prisma } from '@/lib/db';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { isEmergencyReadOnly } from '@/lib/gateway/policy';
import { ENGINE_CONFIG } from '@/lib/config';
import { checkRateLimit } from '@/lib/rate-limit';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { createImportJob, scheduleImportJob } from '@/lib/jobs/import-job-store';
import { IMPORT_JOB_STATUS } from '@/lib/schemas/import-job';

export const dynamic = 'force-dynamic';

export const POST = defineRoute<{ owner: string; repo: string }>({
  scope: 'POST /api/repos/[owner]/[repo]/web-sync',
  auth: 'user',
  handler: async ({ request, params, userId }) => {
    if (!userId) throw ApiError.unauthorized();

    if (await isEmergencyReadOnly()) {
      throw ApiError.serviceUnavailable('全站维护中，同步暂不可用，请稍后再试', {
        code: 'EMERGENCY_READONLY',
      });
    }

    if (!(await checkRateLimit(`webdoc-sync:${userId}`, ENGINE_CONFIG.rateLimit.webDocSyncMaxRequests, ENGINE_CONFIG.rateLimit.webDocSyncWindowMs))) {
      throw ApiError.tooManyRequests('操作过于频繁，请稍后再试');
    }

    const { owner, repo } = params;

    const repository = await prisma.repository.findFirst({
      where: { owner, repo },
      select: { id: true, isPublic: true, repoProfile: true },
    });

    if (!repository) {
      throw ApiError.notFound('Repository not found');
    }

    const isAuthorized = await verifyRepoAccessDirect(repository, userId);
    if (!isAuthorized) {
      throw ApiError.forbidden('Forbidden: You do not have access to this repository');
    }

    const repoProfile = (repository.repoProfile as Record<string, unknown>) || {};
    if (!repoProfile.originalUrl || repoProfile.sourceType !== 'web') {
      throw ApiError.badRequest('This repository is not a web documentation site');
    }

    const branch = ENGINE_CONFIG.defaultBranch;

    const activeJob = await prisma.importJob.findFirst({
      where: { owner, repo, branch, edition: '', status: { in: [IMPORT_JOB_STATUS.QUEUED, IMPORT_JOB_STATUS.RUNNING] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (activeJob) {
      return ok({ jobId: activeJob.id, deduped: true }, 202);
    }

    const { jobId } = await createImportJob({
      userId,
      owner,
      repo,
      branch,
      edition: '',
      params: {
        kind: 'web-sync',
        userId,
        branch,
        edition: '',
        preExistingRepo: { id: repository.id, isPublic: repository.isPublic },
        options: {},
      },
    });
    await scheduleImportJob(jobId);

    return ok({ jobId }, 202);
  },
});
