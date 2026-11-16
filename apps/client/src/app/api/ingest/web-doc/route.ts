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

/**
 * 入参强校验（Schema Triad：本 Zod ↔ Go EnvelopeOptions ↔ WebDocScopeParams TS）。
 * 作用域不变量经 scopeParamsRefinement 单点收敛：scopeMode 非空 ⇒ allows 非空。
 */
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

/** 从 repoProfile JSON 解析已落盘的生效 allow 集（未落盘 = 存量库 = 通配） */
function profileScopePrefixes(repoProfile: unknown): string[] | undefined {
  if (!repoProfile || typeof repoProfile !== 'object') return undefined;
  const allowed = (repoProfile as Record<string, unknown>).allowedPrefixes;
  return Array.isArray(allowed) && allowed.length > 0 ? (allowed as string[]) : undefined;
}

/** 从在途 Job params JSON 解析提交时的 allow 集（无作用域 = 兜底提交 = 通配） */
function jobParamsScopePrefixes(params: unknown): string[] | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const options = (params as Record<string, unknown>).options;
  if (!options || typeof options !== 'object') return undefined;
  return profileScopePrefixes(options);
}

/**
 * 官方技术文档站导入接口（Job 化）：
 * 同步段做预检（登录/限流/URL 校验/复用检测/额度/在途去重）→ 建 ImportJob → 202 {jobId}。
 * 分钟级抓取在 Job 内执行（进度经 /api/ingest-jobs/[id]/events SSE 或轮询读取）。
 */
export const POST = defineRoute({
  scope: 'POST /api/ingest/web-doc',
  auth: 'user',
  rateLimit: {
    // 网页抓取为分钟级外部操作：限流从严（对比其余 LLM 路由同款 checkRateLimit 设施）
    limit: ENGINE_CONFIG.rateLimit.webDocIngestMaxRequests,
    windowMs: ENGINE_CONFIG.rateLimit.webDocIngestWindowMs,
    identifier: ({ userId }) => `webdoc-ingest:${userId ?? 'anonymous'}`,
  },
  bodySchema: webDocIngestSchema,
  handler: async ({ body, userId }) => {
    if (!userId) throw ApiError.unauthorized('请先登录', { code: 'UNAUTHORIZED' });

    // 紧急只读熔断：暂停新导入提交（策略库故障 fail-open）
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

    // SSRF 防护：服务端将抓取该 URL 并把正文入库可读，私网/回环/云元数据一律拒绝
    // （与 scout 向导路径的 isPrivateOrLoopbackHost 同口径——此前仅本直连路由漏防）
    const { isPrivateOrLoopbackHost } = await import('@/lib/url-inspector');
    if (isPrivateOrLoopbackHost(urlObj.hostname)) {
      throw ApiError.badRequest('不允许抓取内网、回环或云元数据地址', { code: 'PRIVATE_NETWORK_BLOCKED' });
    }
    // 剥离 Basic Auth 明文凭据后再入库/抓取（对齐 url-inspector 的脱敏口径）
    urlObj.username = '';
    urlObj.password = '';

    const slugName = (name || urlObj.hostname.replace(/[^a-z0-9_-]/gi, '-')).toLowerCase();
    const owner = WEB_DOC_OWNER;
    const repo = slugName;
    const branch = ENGINE_CONFIG.defaultBranch;

    // 1. 全网秒级复用检查——仅公开请求复用已有公共库；
    //    私有请求不复用（与主管线真冻结语义一致：私有副本与共享行按 ownerUserId 并存）
    if (isPublic) {
      const existingRepo = await prisma.repository.findUnique({
        where: { owner_repo_branch_edition: { owner, repo, branch, edition: '' } },
        select: { id: true, isPublic: true, reviewStatus: true, repoProfile: true },
      });

      if (existingRepo?.isPublic && existingRepo.reviewStatus === 'APPROVED') {
        // 作用域一致性核验：两侧均显式声明且不相等 ⇒ 拒绝复用（防止跨作用域静默错配，
        // 也防止拒绝后落入对同一公共库的破坏性覆盖）。存量库无作用域字段 = 通配全集，平滑复用。
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

    // 仓数上限预检（与 GitHub 导入同额度池——网页库同样占用教程位）
    const tierUser = await prisma.user.findUnique({ where: { id: userId }, select: { tier: true, role: true } });
    const repoLimit = await checkRepoLimit(userId, {
      role: tierUser?.role,
      tier: tierUser?.tier,
      targetRepo: { owner, repo },
    });
    if (!repoLimit.allowed) {
      // 结构化额度错误（含升级引导字段），走透传保持原响应契约
      return NextResponse.json(repoLimitErrorResponse(userId, repoLimit), { status: 403 });
    }

    // 知识算力积分与 Web 爬虫单次物理上限 (200页/300分) 校验
    const { CREDITS_CONFIG, estimateRequiredCredits, getDynamicCreditsConfig } = await import('@/lib/credits-config');
    const dynamicConfig = await getDynamicCreditsConfig();
    const { validateImportCredits } = await import('@/lib/credits-ledger');
    // 页数上限：用户期望超过物理上限时按上限截断（积分预估与抓取共用同一口径）
    const hardCap = dynamicConfig.webDocMaxPages || CREDITS_CONFIG.WEB_DOC_MAX_PAGES;
    const requestedPages = Number(maxPages) || hardCap;
    const effectiveMaxPages = Math.min(requestedPages, hardCap);
    // 字符基准走动态配置（B3：不再内联 1500，admin 调参即时生效）
    const estimated = estimateRequiredCredits({
      docCount: effectiveMaxPages,
      totalChars: effectiveMaxPages * dynamicConfig.standardChunkCharSize,
      isPublic: Boolean(isPublic),
      isCodePedagogy: false,
    }, dynamicConfig);

    // 导入转录全面 0 消耗，无需配额校验拦截
    await validateImportCredits(userId, estimated.finalCredits);

    // 在途去重：同站在途 Job 直接复用（与主 ingest 同模式）；
    // 归属过滤必须带 userId——否则 A 复用到 B 的 jobId 后，events/快照按归属拒绝，B 的导入静默丢失
    const activeJob = await prisma.importJob.findFirst({
      where: { owner, repo, branch, edition: '', userId, status: { in: [IMPORT_JOB_STATUS.QUEUED, IMPORT_JOB_STATUS.RUNNING] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, params: true },
    });
    if (activeJob) {
      // 作用域一致性核验：同仓在途任务若使用了不同抓取范围，拒绝并行复用——
      // 否则第二个 Job 会与在途任务形成同 repo 行双写（违反 Single-Writer 收敛尾）
      if (!scopeMatches(body.allowedPrefixes, jobParamsScopePrefixes(activeJob.params))) {
        throw ApiError.conflict('该站点已有不同抓取范围的导入任务正在进行，请等待完成后再试', {
          code: 'WEB_DOC_SCOPE_CONFLICT',
        });
      }
      return ok({ jobId: activeJob.id, deduped: true }, 202);
    }

    // 回滚守卫快照：本轮新建（无既有行）失败时允许整仓清理
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
          isPublic: false, // Publication follows the existing safety gate after content completion.
          category: typeof body.category === 'string' ? body.category : undefined,
          tags: Array.isArray(body.tags) ? body.tags : [],
          // 确认页作用域透传（Go EnvelopeOptions 对齐字段；scopeMode='' 走自动裁决兜底）
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
