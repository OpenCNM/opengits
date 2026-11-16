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

/**
 * 官方技术文档增量同步接口（Job 化）：
 * 同步段做预检（登录/限流/归属/sourceType 校验/在途去重）→ 建 ImportJob（kind: web-sync）→ 202。
 * 差分探测（sitemap/ETag）与增量抓取在 Job 内执行，进度经 ingest-jobs 事件流读取。
 */
export const POST = defineRoute<{ owner: string; repo: string }>({
  scope: 'POST /api/repos/[owner]/[repo]/web-sync',
  auth: 'user',
  handler: async ({ request, params, userId }) => {
    // auth:'user' 已拦截未登录；此处收窄仅为类型细化（防御性，不可达）
    if (!userId) throw ApiError.unauthorized();

    // 紧急只读熔断：暂停增量同步提交（策略库故障 fail-open）
    if (await isEmergencyReadOnly()) {
      throw ApiError.serviceUnavailable('全站维护中，同步暂不可用，请稍后再试', {
        code: 'EMERGENCY_READONLY',
      });
    }

    // 同步涉及外部抓取，限流（重复点击/脚本滥用防护）
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

    // 在途去重：同库在途同步 Job 直接复用
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
        // 同步失败不做整仓清理（已有库不受影响）——守卫快照恒为「已存在」
        preExistingRepo: { id: repository.id, isPublic: repository.isPublic },
        options: {},
      },
    });
    await scheduleImportJob(jobId);

    return ok({ jobId }, 202);
  },
});
