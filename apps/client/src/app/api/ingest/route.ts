import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { checkRateLimit } from '@/lib/rate-limit';
import { ENGINE_CONFIG } from '@/lib/config';
import { checkRepoLimit, repoLimitErrorResponse } from '@/lib/tiers';
import { resolveEditionForKey } from '@/lib/edition';
import { WEB_DOC_OWNER, normalizeCategory } from '@/lib/constants';
import { IMPORT_JOB_STATUS } from '@/lib/schemas/import-job';
import { createImportJob, scheduleImportJob } from '@/lib/jobs/import-job-store';
import { getActiveTagRegistry, canonicalizeTag, classifyTags, syncTagsToRegistry, resolveDraftTags, reconcileCategoryWithEvidence, FALLBACK_CATEGORY } from '@/lib/tag-registry';
import { repoCategoryInputSchema, repoTagsInputSchema } from '@/lib/validations/tag-registry';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { assert } from '@/lib/api/server/api-guards';
import { isEmergencyReadOnly } from '@/lib/gateway/policy';

export const dynamic = 'force-dynamic';

/**
 * Phase B：工作与连接解耦。
 *
 * 本路由只做同步预检（快速失败）→ 建 ImportJob → 进程内异步执行 → 立即 202 {jobId}。
 * 进度经 GET /api/ingest-jobs/[id]（快照轮询）或 /api/ingest-jobs/[id]/events（可续传 SSE）
 * 读取；断线/关页零损失，worker 心跳过期由读取端惰性判 FAIL。
 *
 * body 是跨客户端版本的多版本兼容包（~40 字段，含 profile/versions/draftOutline 等
 * 复杂对象），校验即归一化逻辑本身，故不套 bodySchema，保留手动解析。
 */
export const POST = defineRoute({
  scope: 'POST /api/ingest',
  auth: 'user',
  rateLimit: {
    // 导入限流（防队列槽位被单人占满；对齐 web-doc 从严口径）
    limit: ENGINE_CONFIG.rateLimit.ingestMaxRequests,
    windowMs: ENGINE_CONFIG.rateLimit.ingestWindowMs,
    identifier: ({ userId }) => `ingest:${userId ?? 'anonymous'}`,
  },
  handler: async ({ request, userId }) => {
    // 紧急只读熔断：暂停新导入提交，保住主站阅读（策略库故障 fail-open）
    assert(!(await isEmergencyReadOnly()), 'SERVICE_UNAVAILABLE');

    const req = request as NextRequest;
    const body = await req.json();
    let { owner, repo, branch, prefixFilter, prefix, useAi, menuStyle, targetLanguage, customPrompt, transcriptionPreset, editionLabel, aiGranularity, aiCondensation, teachingDepth, category, tags, customOutline, outline, repoUrl, versionLabel, customExtensions, starCount, profile, versions, currentSha, draftOutline } = body;

    // 安全面收口：GitHub 导入一律私有落库（真冻结），body.isPublic 直接忽略——
    // 公开的唯一通道是 PATCH /api/repos/publish（License Gate + 平台安全审核 + 评分 + publishedAt）。
    // 否则直调本 API 传 isPublic:true 可让引擎 upsert 无条件置公开，整条发布审核链被绕过。
    assert(body.isPublic === undefined || typeof body.isPublic === 'boolean', 'INVALID_PARAM');
    const publishRequested = body.isPublic === true;
    const isPublic = false;

    // Normalize parameter names across different client versions
    if (!owner || !repo) {
      if (repoUrl && typeof repoUrl === 'string') {
        const clean = repoUrl.replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
        const parts = clean.split('/');
        if (parts.length >= 2) {
          owner = parts[0];
          repo = parts[1];
        }
      }
    }
    const finalPrefixFilter = prefixFilter !== undefined ? prefixFilter : (prefix !== undefined ? prefix : '');
    const finalUseAi = useAi !== undefined ? useAi : (menuStyle === 'ai');
    const finalCustomOutline = customOutline !== undefined ? customOutline : outline;
    const finalBranch = branch || ENGINE_CONFIG.defaultBranch;

    assert(owner && repo, 'INVALID_PARAM', 'Missing owner/repo');

    // BUG-01 防御：强制入参小写归一化，杜绝大小写绕过唯一键防重
    const { canonicalizeRepo } = await import('@/lib/repo-dedup');
    const canonical = canonicalizeRepo(owner, repo);
    owner = canonical.owner;
    repo = canonical.repo;

    // 若入参未提供有效的 GitHub Stars（例如脚本导入、直接调 API、或向导缓存缺失），
    // 且当前不是 web-doc 网页抓取仓库，则主动向 GitHub 探测一次真实 starCount
    // 降级登记（eval 可观测）：非阻断探测失败记录到任务 params，Go 原样持久化（Params any JSON 直通）
    const degradations: string[] = [];
    let probedDescription = '';
    if ((typeof starCount !== 'number' || starCount <= 0 || !(profile as Record<string, unknown> | undefined)?.description) && owner !== WEB_DOC_OWNER) {
      try {
        const { fetchRepoMeta } = await import('@/lib/scout/pipeline/repo-meta');
        const { meta } = await fetchRepoMeta(owner, repo, userId);
        if ((typeof starCount !== 'number' || starCount <= 0) && meta.starCount > 0) {
          starCount = meta.starCount;
        }
        if (meta.description?.trim()) {
          probedDescription = meta.description.trim();
        }
      } catch (err) {
        // 容错降级: GitHub starCount 探测失败不阻断导入流程（排序/推荐降级），留痕观测
        console.warn('[ingest] starCount probe failed:', err);
        degradations.push('starCount');
      }
    }

    // 解析讲法标识（第一性原理 SSOT）：
    const edition = resolveEditionForKey(body);

    // 同仓导入幂等（P-04）：同一用户对同 (owner, repo, branch, edition) 的重复提交
    // （连点/双击/断线重试）自动附着到在途任务——返回既有 jobId + deduped:true
    // （202，向后兼容；前端拿 jobId 照常接进度流即可）。
    // 跨用户并发刻意不拦：重复发布在 publish 路由有 DUPLICATE_EXPLORE 兜底，
    // 私有仓多人协作/多讲法场景不误伤。
    const activeJob = await prisma.importJob.findFirst({
      where: {
        owner,
        repo,
        branch: finalBranch,
        edition,
        status: { in: [IMPORT_JOB_STATUS.QUEUED, IMPORT_JOB_STATUS.RUNNING] },
      },
      select: { id: true, userId: true },
    });
    if (activeJob && activeJob.userId === userId) {
      return ok({ jobId: activeJob.id, ...(edition ? { edition } : {}), deduped: true }, 202);
    }

    // 入库前预检（两处守卫共用的存在性快照，取于管线启动前）：
    // 1) 失败回滚守卫：仅当仓库是本轮新建时才允许整仓清理，绝不动既有教程；
    // 2) 公开仓接管守卫：同讲法的基础行已公开时，不允许私有导入覆盖共享行——
    //    但「新讲法」导入（edition≠''）允许与公开基础行共存（衍生转录流）。
    // BUG-02 防御：检查 documents，若公开仓文档数为 0（转录中断空仓），不予拦截，允许重新导入修复
    const preExistingRepo = await prisma.repository.findFirst({
      where: {
        owner: { equals: owner, mode: 'insensitive' },
        repo: { equals: repo, mode: 'insensitive' },
        branch: finalBranch,
        edition,
      },
      select: {
        id: true,
        isPublic: true,
        documents: { select: { id: true }, take: 1 },
      },
    });
    const hasExistingDocs = (preExistingRepo?.documents?.length ?? 0) > 0;
    if (preExistingRepo && hasExistingDocs && !edition) {
      // 遵循版本不可变公理：无论是否为维护者，已有正规文档的仓库严禁原地覆写
      // 强制调用方走衍生讲法（createEdition=true / edition="ed_xxxx"）
      assert(
        false,
        'CONFLICT',
        `${owner}/${repo} tutorial already exists. Please create a new edition instead of overwriting the primary tutorial.`
      );
    }

    // 讲法越权守卫：显式 edition 命中既有行（key 仅 32bit 熵，可被猜中）时，
    // 仅允许该行创建者（有 ImportRecord）重新导入——否则他人可附着/覆盖
    // 别人的讲法行（私有讲法内容泄露面 + 公开讲法被篡改面）。
    // 衍生转录流不受影响：createEdition=true 生成全新 key，不会命中既有行。
    if (edition && preExistingRepo && hasExistingDocs) {
      const ownRecord = await prisma.importRecord.findFirst({
        where: { userId, repositoryId: preExistingRepo.id },
        select: { id: true },
      });
      assert(!!ownRecord, 'CONFLICT', `edition ${edition} is owned by another user`);
    }

    // 仓数上限预检（覆盖所有客户端版本，含绕过 scout 直调；重复导入已有仓不占新额度）
    const tierUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { tier: true, role: true },
    });
    const repoLimit = await checkRepoLimit(userId, {
      role: tierUser?.role,
      tier: tierUser?.tier,
      targetRepo: { owner, repo },
    });
    if (!repoLimit.allowed) {
      // 结构化额度错误（含升级引导字段），走透传保持原响应契约
      return NextResponse.json(repoLimitErrorResponse(userId, repoLimit), { status: 403 });
    }

    // 计费口径（P-04 单写者收敛后）：提交期零积分准入——冻结/估算均不落 Node
    // （历史 estimateImportBilling→params.estimatedCredits 链 Go 侧零读取，已拆）；
    // 实际计费由 Go settle 期按实际处理章节数结算，赚取侧 7 天质押成熟。

    // 标签词表归一（落库前最后一道闸）：
    // - category 严格封闭词表：入参优先，其次 draftOutline 伴生产出，不中即落 'Others'，绝不留空或生成 imported
    // - tags 经词表归一；词表外新值受控登记进注册表（source='ai'）
    const tagRegistry = await getActiveTagRegistry();
    const draftTags = await resolveDraftTags(draftOutline);
    const rawCategory = repoCategoryInputSchema.safeParse(category).success ? String(category).trim() : undefined;
    const normalizedCategory = rawCategory ? normalizeCategory(rawCategory) : undefined;
    const candidateCategory = normalizedCategory
      ? (canonicalizeTag(normalizedCategory, tagRegistry, 'CATEGORY') ?? canonicalizeTag(rawCategory!, tagRegistry, 'CATEGORY') ?? FALLBACK_CATEGORY)
      : (draftTags.category ?? FALLBACK_CATEGORY);
    const rawTags = (repoTagsInputSchema.safeParse(tags).success && Array.isArray(tags) && tags.length > 0)
      ? tags
      : (draftTags.tags ?? []);
    const classifiedTags = classifyTags(rawTags, tagRegistry, 'TAG');
    if (classifiedTags.unknown.length > 0) {
      await syncTagsToRegistry('TAG', classifiedTags.unknown, 'ai');
    }
    const finalTags = classifiedTags.known.concat(classifiedTags.unknown);
    const canonicalCategory = reconcileCategoryWithEvidence({
      category: candidateCategory,
      tags: finalTags,
    });

    // 激活转录模型解析（Phase C1 / 讲法标识基石）：
    // 调用方显式 model/transcriptionModel 优先，缺省读取当前用户激活模型
    let activeModelId = '';
    try {
      const { resolveActiveUserModel } = await import('@/lib/ai/user-model-resolver');
      const activeUserModel = await resolveActiveUserModel(userId);
      activeModelId = activeUserModel?.modelId?.trim() || '';
    } catch (err) {
      // 容错降级：测试环境或单元测试 mock 未注入 userModelProvider 时安全降级，留痕区分配置缺失与解析异常
      console.warn('[ingest] active model resolution failed:', err);
      degradations.push('activeModel');
    }
    const resolvedModel =
      (typeof body.transcriptionModel === 'string' && body.transcriptionModel.trim()) ||
      (typeof body.model === 'string' && body.model.trim()) ||
      activeModelId;

    const mergedProfile = {
      ...(profile && typeof profile === 'object' ? profile : {}),
      ...(probedDescription && !(profile as Record<string, unknown> | undefined)?.description
        ? { description: probedDescription }
        : {}),
      ...(resolvedModel ? { transcriptionModel: resolvedModel } : {}),
    };

    // 建 Job（含回滚守卫所需快照与归一化后的完整入参）→ Go worker 异步执行 → 立即返回。
    // 原子入场（B5 + TOCTOU 修复）在 Go /v1/jobs/create 单写者内闭环（advisory-lock
    // 防重 + 活跃 Job 复用）；重复提交返回既有 Job（deduped）且不重复 schedule
    const { jobId, deduped } = await createImportJob(
      {
        userId,
        owner,
        repo,
        branch: finalBranch,
        edition,
        params: {
        userId,
        branch: finalBranch,
        edition,
        frozenCredits: 0,
        degradations: degradations.length > 0 ? degradations : undefined,
        publishRequested,
        preExistingRepo: preExistingRepo ? { id: preExistingRepo.id, isPublic: preExistingRepo.isPublic } : null,
        options: {
          prefixFilter: finalPrefixFilter,
          useAi: finalUseAi,
          targetLanguage,
          customPrompt,
          transcriptionPreset,
          model: resolvedModel || undefined,
          transcriptionModel: resolvedModel || undefined,
          edition,
          editionLabel,
          aiGranularity,
          aiCondensation,
          teachingDepth,
          isPublic,
          category: canonicalCategory,
          tags: finalTags,
          customOutline: finalCustomOutline,
          versionLabel,
          customExtensions,
          starCount,
          repoProfile: mergedProfile,
          versions,
          gitSha: currentSha ?? undefined,
          draftOutline,
        },
        },
      }
    );

    if (deduped) {
      return ok({ jobId, ...(edition ? { edition } : {}), deduped: true }, 202);
    }

    // 并发闸门：有空位零延迟启动，无空位保持 QUEUED 排队（用户可见排队位）
    await scheduleImportJob(jobId);

    return ok({ jobId, ...(edition ? { edition } : {}) }, 202);
  },
});
