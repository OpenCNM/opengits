import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { checkRepoLimit, repoLimitErrorResponse } from '@/lib/tiers';
import { createImportJob, scheduleImportJob } from '@/lib/jobs/import-job-store';
import { IMPORT_JOB_STATUS } from '@/lib/schemas/import-job';
import { WEB_DOC_OWNER } from '@/lib/jobs/web-doc-job';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { isEmergencyReadOnly } from '@/lib/gateway/policy';
import {
  webDocScopeFields,
  scopeParamsRefinement,
  scopeMatches,
} from '@/lib/schemas/webdoc-topology';

export const dynamic = 'force-dynamic';

const webDocIngestSchema = z
  .object({
    url: z.string().min(1).max(2048),
    name: z.string().max(200).optional(),
    isPublic: z.boolean().default(true),
    maxPages: z.number().int().positive().optional(),
    category: z.string().max(100).optional(),
    tags: z.array(z.string().max(50)).max(12).optional(),
  })
  .extend(webDocScopeFields.shape)
  .superRefine(scopeParamsRefinement);

function profileScopePrefixes(repoProfile: unknown): string[] | undefined {
  if (!repoProfile || typeof repoProfile !== 'object') return undefined;
  const allowed = (repoProfile as Record<string, unknown>).allowedPrefixes;
  return Array.isArray(allowed) && allowed.length > 0 ? (allowed as string[]) : undefined;
}

function jobParamsScopePrefixes(params: unknown): string[] | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const options = (params as Record<string, unknown>).options;
  if (!options || typeof options !== 'object') return undefined;
  return profileScopePrefixes(options);
}

export const POST = defineRoute({
  scope: 'POST /api/ingest/web-doc',
  auth: 'user',
  rateLimit: {
    limit: ENGINE_CONFIG.rateLimit.webDocIngestMaxRequests,
    windowMs: ENGINE_CONFIG.rateLimit.webDocIngestWindowMs,
    identifier: ({ userId }) => `webdoc-ingest:${userId ?? 'anonymous'}`,
  },
  bodySchema: webDocIngestSchema,
  handler: async ({ body, userId }) => {
    if (!userId) throw ApiError.unauthorized('请先登录', { code: 'UNAUTHORIZED' });

    if (await isEmergencyReadOnly()) {
      throw ApiError.serviceUnavailable('全站维护中，导入暂不可用，请稍后再试', {
        code: 'EMERGENCY_READONLY',
      });
    }

    const { url, name, isPublic, maxPages } = body;

    let urlObj: URL;
    try {
      urlObj = new URL(url);
      if (!/^https?:$/.test(urlObj.protocol)) {
        throw ApiError.badRequest('仅支持 http/https 文档站地址', { code: 'INVALID_PROTOCOL' });
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw ApiError.badRequest('无效的 URL 格式', { code: 'INVALID_URL' });
    }

    const { isPrivateOrLoopbackHost } = await import('@/lib/url-inspector');
    if (isPrivateOrLoopbackHost(urlObj.hostname)) {
      throw ApiError.badRequest('不允许抓取内网、回环或云元数据地址', { code: 'PRIVATE_NETWORK_BLOCKED' });
    }
    urlObj.username = '';
    urlObj.password = '';

    const slugName = (name || urlObj.hostname.replace(/[^a-z0-9_-]/gi, '-')).toLowerCase();
    const owner = WEB_DOC_OWNER;
    const repo = slugName;
    const branch = ENGINE_CONFIG.defaultBranch;

    if (isPublic) {
      const existingRepo = await prisma.repository.findUnique({
        where: { owner_repo_branch_edition: { owner, repo, branch, edition: '' } },
        select: { id: true, isPublic: true, reviewStatus: true, repoProfile: true },
      });

      if (existingRepo?.isPublic && existingRepo.reviewStatus === 'APPROVED') {
        if (!scopeMatches(body.allowedPrefixes, profileScopePrefixes(existingRepo.repoProfile))) {
          throw ApiError.conflict(
            '该站点已存在不同抓取范围的公共教程库，无法按当前选择复用或覆盖',
            { code: 'WEB_DOC_SCOPE_CONFLICT' }
          );
        }
        await prisma.userReadingProgress.upsert({
          where: { userId_repositoryId: { userId, repositoryId: existingRepo.id } },
          update: {},
          create: { userId, repositoryId: existingRepo.id },
        });

        return ok({
          reused: true,
          repositoryId: existingRepo.id,
          owner,
          repo,
          message: '已命中全网已有公共文档库，已直接为你打开！',
        });
      }
    }

    const tierUser = await prisma.user.findUnique({ where: { id: userId }, select: { tier: true, role: true } });
    const repoLimit = await checkRepoLimit(userId, {
      role: tierUser?.role,
      tier: tierUser?.tier,
      targetRepo: { owner, repo },
    });
    if (!repoLimit.allowed) {
      return NextResponse.json(repoLimitErrorResponse(userId, repoLimit), { status: 403 });
    }

    const { CREDITS_CONFIG, estimateRequiredCredits, getDynamicCreditsConfig } = await import('@/lib/credits-config');
    const dynamicConfig = await getDynamicCreditsConfig();
    const { validateImportCredits } = await import('@/lib/credits-ledger');
    const hardCap = dynamicConfig.webDocMaxPages || CREDITS_CONFIG.WEB_DOC_MAX_PAGES;
    const requestedPages = Number(maxPages) || hardCap;
    const effectiveMaxPages = Math.min(requestedPages, hardCap);
    const estimated = estimateRequiredCredits({
      docCount: effectiveMaxPages,
      totalChars: effectiveMaxPages * dynamicConfig.standardChunkCharSize,
      isPublic: Boolean(isPublic),
      isCodePedagogy: false,
    }, dynamicConfig);

    await validateImportCredits(userId, estimated.finalCredits);

    const activeJob = await prisma.importJob.findFirst({
      where: { owner, repo, branch, edition: '', userId, status: { in: [IMPORT_JOB_STATUS.QUEUED, IMPORT_JOB_STATUS.RUNNING] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, params: true },
    });
    if (activeJob) {
      if (!scopeMatches(body.allowedPrefixes, jobParamsScopePrefixes(activeJob.params))) {
        throw ApiError.conflict('该站点已有不同抓取范围的导入任务正在进行，请等待完成后再试', {
          code: 'WEB_DOC_SCOPE_CONFLICT',
        });
      }
      return ok({ jobId: activeJob.id, deduped: true }, 202);
    }

    const preExisting = await prisma.repository.findUnique({
      where: { owner_repo_branch_edition: { owner, repo, branch, edition: '' } },
      select: { id: true, isPublic: true },
    });

    const { jobId } = await createImportJob({
      userId,
      owner,
      repo,
      branch,
      edition: '',
      params: {
        kind: 'web-doc',
        userId,
        branch,
        edition: '',
        frozenCredits: 0,
        estimatedCredits: estimated,
        publishRequested: isPublic,
        preExistingRepo: preExisting,
        options: {
          url: urlObj.toString(),
          name: typeof name === 'string' ? name : undefined,
          maxPages: effectiveMaxPages,
          isPublic: false,
          category: typeof body.category === 'string' ? body.category : undefined,
          tags: Array.isArray(body.tags) ? body.tags : [],
          scopeMode: body.scopeMode,
          primaryDocPrefix: body.primaryDocPrefix,
          allowedPrefixes: body.allowedPrefixes,
          moduleTabs: body.moduleTabs,
        },
      },
    });
    await scheduleImportJob(jobId);

    return ok({ jobId }, 202);
  },
});
