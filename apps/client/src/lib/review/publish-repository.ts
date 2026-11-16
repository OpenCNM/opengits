import { revalidateTag } from 'next/cache';
import { z } from 'zod';
import { WEB_DOC_OWNER } from '@/lib/jobs/web-doc-job';
import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/server/api-error';
import { checkRepoDuplicates } from '@/lib/repo-dedup';
import { isAdminRole } from '@/lib/tiers';
import { resolveMaintainerUserId } from '@/lib/repository-maintainer';
import { computePipelineScore } from '@/lib/review/pipeline-score';
import { reviewTutorialByPlatform, buildReviewFeedback } from '@/lib/review/platform-review';
import { decideReview } from '@/lib/review/decision';
import { PUBLIC_HOME_CACHE_TAG } from '@/lib/home/public-home-data';

import { getPublicationContent, requestImportPublication, sharePublicationDocuments } from '@/lib/credits/import-reward';
import { callSidecar } from '@/lib/sidecar-client';
import { publishFanout } from '@/lib/review/publish-fanout';

export async function publishRepository(userId: string, input: { repoId?: string; owner?: string; repoName?: string; edition?: string; relayEnabled?: boolean; onlyToggleRelay?: boolean; withdraw?: boolean }) {
  const { repoId, owner, repoName, edition, relayEnabled, onlyToggleRelay, withdraw } = input;
    // Lookup repository with savedRepos relationship for access control
    const repository = repoId
      ? await prisma.repository.findUnique({
          where: { id: repoId },
          include: {
            documents: { select: { id: true, title: true } },
            savedRepos: { where: { userId }, select: { userId: true } },
          },
        })
      : await prisma.repository.findFirst({
          where: {
            owner: owner!,
            repo: repoName!,
            ...(edition !== undefined ? { edition } : {}),
          },
          orderBy: { updatedAt: 'desc' },
          include: {
            documents: { select: { id: true, title: true } },
            savedRepos: { where: { userId }, select: { userId: true } },
          },
        });

    if (!repository) {
      throw ApiError.notFound('未找到该仓库记录');
    }

    // Security Check（写操作门禁）：发布/翻转 relayEnabled 是维护者级操作。
    // 旧实现用 verifyRepoAccessDirect（读门语义：公开仓对所有人 true）——
    // 任意登录用户可重放他人公开仓的发布、翻转社区接力开关。
    // 维护者 SSOT = 最早 ImportRecord 用户（resolveMaintainerUserId，与
    // auto-sync/向导同一事实源）；管理员放行。
    const maintainerId = await resolveMaintainerUserId(repository.id);
    const role = userId ? (await prisma.user.findUnique({ where: { id: userId }, select: { role: true } }))?.role : null;
    const isMaintainer = !!userId && userId === maintainerId;
    if (!isMaintainer && !isAdminRole(role)) {
      throw ApiError.forbidden('权限不足，仅教程维护者或管理员可发布该教程');
    }

    // 提审撤回通道：处于审核中（PENDING）时支持撤回为私有草稿（NONE）
    if (withdraw) {
      if (repository.reviewStatus !== 'PENDING') {
        throw ApiError.badRequest('当前教程不处于审核中状态，无法撤回');
      }
      const noneStatus = 'NONE';
      await callSidecar(
        '/v1/repos/patch',
        {
          id: repository.id,
          reviewStatus: noneStatus,
          clearRejectionReason: true,
        },
        { label: 'publish-withdraw-review-patch' }
      );
      revalidateTag(PUBLIC_HOME_CACHE_TAG, 'max');

      return {
        withdrawn: true,
        reviewStatus: 'NONE',
        message: '已撤回提审，教程已恢复为私有草稿',
      };
    }

    // 快速接力开关通道（无需触发完整发布流水线）
    if (onlyToggleRelay && typeof relayEnabled === 'boolean') {
      await callSidecar(
        '/v1/repos/patch',
        {
          id: repository.id,
          relayEnabled,
        },
        { label: 'publish-relay-only-patch' }
      );
      // 扇出复用（缓存/通知全部幂等，通知有 relayNotifiedAt 事实戳防重）
      await publishFanout(repository.id, 'relay-toggle', { relayEnabledOverride: relayEnabled });

      return {
        alreadyPublic: repository.isPublic,
        relayEnabled,
        message: relayEnabled ? '已开启社区接力' : '已关闭社区接力',
      };
    }

    // Action: PUBLISH
    // Check 1: Explore Deduplication Gate
    await requestImportPublication(repository.id, userId);
    if (repository.isPublic && repository.reviewStatus === 'APPROVED') {
      // 已公开教程：若传入 relayEnabled 且与当前状态不一致，则更新接力状态
      if (typeof relayEnabled === 'boolean' && relayEnabled !== repository.relayEnabled) {
        await callSidecar(
          '/v1/repos/patch',
          {
            id: repository.id,
            relayEnabled,
          },
          { label: 'publish-relay-toggle-patch' }
        );
        // 扇出复用（缓存幂等，通知由 relayNotifiedAt 事实戳防重）
        await publishFanout(repository.id, 'relay-toggle', { relayEnabledOverride: relayEnabled });

        return {
          alreadyPublic: true,
          relayEnabled,
          message: relayEnabled ? '已开启社区接力' : '已关闭社区接力',
        };
      }

      // 已公开重试：重跑完整扇出（全步骤幂等——发奖双层防重、缓存/L1 天然收敛、
      // 通知有事实戳防重），用户重试即自愈此前任何尾部漂移
      await publishFanout(repository.id, 'retry');
      return {
        alreadyPublic: true,
        message: '该仓库已处于公开状态',
      };
    }

    const dedupInfo = await checkRepoDuplicates({
      owner: repository.owner,
      repo: repository.repo,
      userId,
      // 讲法判重：同讲法公开行才拦；发布该仓库的「另一种讲法」合法放行
      edition: repository.edition ?? '',
    });

    if (dedupInfo.existsInExplore && !repository.isPublic) {
      throw ApiError.conflict('探索广场中已存在该仓库的公开教程，不可重复发布。', {
        code: 'DUPLICATE_EXPLORE',
      });
    }

    // ── 同源相似归簇（建议性，零拦截；与评分并行可容忍，失败静默——增强能力非关键路径）──
    // 命中同源 → 采纳被命中行簇键（广场归一张卡展示）；未命中 → 自成新簇。
    // 复用 ingest 期持久化的骨架签名（existingSignature），无需再取树。
    let adoptedClusterKey: string | null = null;
    try {
      const { runSourceDetection } = await import('@/lib/similarity/service');
      const { adoptCluster, mergeSameSourceIntoProfile } = await import('@/lib/similarity/cluster');
      const detection = await runSourceDetection({
        owner: repository.owner,
        repo: repository.repo,
        branch: repository.branch,
        gitSha: repository.gitSha,
        existingSignature: {
          skeleton: (repository as any).skeleton ?? null,
          skeletonHash: (repository as any).skeletonHash ?? null,
        },
      });
      const canonicalRepoKey = `${(repository.owner || '').toLowerCase()}/${(repository.repo || '').toLowerCase()}`;
      adoptedClusterKey = await adoptCluster(
        repository.id,
        canonicalRepoKey,
        detection
      );
      if (detection.best) {
        await callSidecar(
          '/v1/repos/patch',
          {
            id: repository.id,
            repoProfile: mergeSameSourceIntoProfile(
              ((repository.repoProfile as Record<string, unknown>) ?? {}),
              detection
            ),
          },
          { label: 'publish-repo-profile-patch' }
        );
      }
    } catch (simErr) {
      console.warn('[publish route] similarity clustering skipped, falling back to default cluster key:', simErr);
    }
    // BUG-12 防护：异常与 adoptCluster 内部吞错（返回 null）两条失败路径都补写
    // 自身确定性簇键，防止 sourceClusterKey 悬空为 null 导致广场分组孤立分裂
    if (adoptedClusterKey == null) {
      const fallbackKey = `${(repository.owner || '').toLowerCase()}/${(repository.repo || '').toLowerCase()}`;
      await callSidecar(
        '/v1/repos/patch',
        {
          id: repository.id,
          sourceClusterKey: fallbackKey,
        },
        { label: 'publish-cluster-fallback-patch' }
      ).catch(() => {});
    }

    // Check 2: Transcription Completeness Gate
    const content = await getPublicationContent(prisma, repository.id, userId);
    if (!content.ready) {
      throw new ApiError(422, '该教程尚未完成文档转录解析，暂不可发布。', {
        code: 'INCOMPLETE_TRANSCRIPTION',
      });
    }

    // Check 2b: License Gate（公开=衍生内容，上游无许可证不可公开；探测失败放行）
    const { checkPublishLicense } = await import('@/lib/review/license-gate');
    const webProfile = z.object({ sourceType: z.literal('web') }).safeParse(repository.repoProfile);
    // A crawled website has no GitHub repository/license endpoint. Platform safety review still applies.
    const license = repository.owner === WEB_DOC_OWNER && webProfile.success
      ? { allowed: true, reason: undefined }
      : await checkPublishLicense({
          id: repository.id, owner: repository.owner, repo: repository.repo,
          repoProfile: repository.repoProfile,
        });
    if (!license.allowed) {
      // license-gate 的所有 !allowed 分支都携带 reason；?? 仅兜底类型上的可选性
      throw new ApiError(422, license.reason ?? 'License check failed', { code: 'NO_LICENSE' });
    }

    // Check 3: Document Content Quality Gate
    const hasValidDoc = repository.documents.some(
      d => d.title && d.title.trim().length > 0
    );
    if (!hasValidDoc) {
      throw new ApiError(422, '教程文档内容缺失或结构异常，校验未通过。', {
        code: 'INVALID_CONTENT',
      });
    }

    // Mutation: Update repository to public with publishedAt timestamp (resilient against stale client cache)
    // Wrapped in transaction to guarantee consistency (Audit 2.3 & 2.6 Fix)
    const nowIso = new Date().toISOString();

    // ── 安全门 + 双通道评分（安全=门，质量=分与动态基准）──
    // 安全裁决走平台中立初审（发布者 BYOK 不能审自己的内容，审计矩阵 BUG-M05-02）；
    // 通过安全门即自动公开（分数进雷达与推荐排序）；若开启 enforceQualityGate，低于基准线亦扣留人工复核。
    const [pipelineScore, llmReview, reviewConfig] = await Promise.all([
      computePipelineScore(repository.id),
      reviewTutorialByPlatform(repository.id, userId),
      prisma.platformReviewConfig.findUnique({ where: { id: 'singleton' } }).catch(() => null),
    ]);
    const thresholds = {
      pipelinePass: reviewConfig?.pipelinePassThreshold ?? 70,
      llmPass: reviewConfig?.llmPassThreshold ?? 75,
      confidenceMin: reviewConfig?.confidenceThreshold ?? 0.7,
      enforceQualityGate: reviewConfig?.enforceQualityGate ?? false,
    };
    const decision = decideReview(pipelineScore, llmReview, thresholds);
    const reviewedPipeline = {
      ...pipelineScore,
      dimensions: pipelineScore.dimensions.map((dimension) => ({ ...dimension })),
      publication: { userId, contentHash: content.contentHash },
    };
    // 审核通道不可用的降级 stub（overallScore:0）不落库——假 0 分会把「未评估」
    // 显示成「架构深度 0」并拖低推荐分；null 才是「缺这条通道」的正确语义
    const llmScoreToStore = llmReview.unavailable ? null : (llmReview as any);

    if (decision.action === 'SAFETY_HOLD') {
      await callSidecar(
        '/v1/repos/patch',
        {
          id: repository.id,
          isPublic: false,
          clearPublishedAt: true,
          reviewStatus: 'PENDING',
          reviewPipeline: reviewedPipeline,
          ...(llmScoreToStore ? { reviewLlm: llmScoreToStore } : { clearReviewLlm: true }),
          clearRejectionReason: true,
        },
        { label: 'publish-safety-hold-patch' }
      );

      // 结构化反馈：告诉用户发生了什么、其生成模型与整改路径（审计矩阵 BUG-M05-02）
      const generatedBy = await prisma.document.findFirst({
        where: { repositoryId: repository.id, generationModel: { not: null } },
        select: { generationModel: true },
        orderBy: { createdAt: 'desc' },
      });
      const review = buildReviewFeedback(llmReview, generatedBy?.generationModel ?? null);

      return {
        submitted: true,
        reviewStatus: 'PENDING',
        rationale: decision.rationale,
        message: '已提交安全复核：系统检测到潜在安全风险，管理员确认通过后将自动公开。',
        review,
      };
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Repository" WHERE id = ${repository.id} FOR UPDATE`;
        const current = await getPublicationContent(tx, repository.id, userId);
        if (!current.ready || current.contentHash !== content.contentHash) {
          throw ApiError.conflict('内容已变化，请重新提交审核');
        }
        await sharePublicationDocuments(tx, repository.id, userId);
      });
      await callSidecar(
        '/v1/repos/patch',
        {
          id: repository.id,
          isPublic: true,
          reviewStatus: 'APPROVED',
          reviewAutoApproved: true,
          reviewPipeline: reviewedPipeline,
          ...(llmScoreToStore ? { reviewLlm: llmScoreToStore } : { clearReviewLlm: true }),
          clearRejectionReason: true,
          touchReviewedAt: true,
          touchPublishedAt: true,
          ...(typeof relayEnabled === 'boolean' ? { relayEnabled } : {}),
        },
        { label: 'publish-approved-patch' }
      );
    } catch (e) {
      console.error('[publish route] transaction publish failed:', e);
      throw ApiError.internal('发布失败，数据库更新异常');
    }

    // 发布事务已提交，尾部跨系统扇出走统一幂等入口（单步失败仅记观测、不级联、不影响发布成功语义）
    await publishFanout(repository.id, 'publish', {
      relayEnabledOverride: typeof relayEnabled === 'boolean' ? relayEnabled : undefined,
    });

    return {
      published: true,
      autoApproved: true,
      publishedAt: nowIso,
      scores: decision.scores,
      message: `已公开至探索广场（管线 ${decision.scores.pipeline} 分 · AI ${decision.scores.llm} 分），分数将随读者行为动态更新排序。`,
    };
}
