import { revalidateTag } from 'next/cache';
import { ignoreBestEffort } from '@/lib/best-effort';
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

    // Verify maintainer/admin write ownership (verifyRepoAccessDirect is read-only and open on public repos).
    const maintainerId = await resolveMaintainerUserId(repository.id);
    const role = userId ? (await prisma.user.findUnique({ where: { id: userId }, select: { role: true } }))?.role : null;
    const isMaintainer = !!userId && userId === maintainerId;
    if (!isMaintainer && !isAdminRole(role)) {
      throw ApiError.forbidden('权限不足，仅教程维护者或管理员可发布该教程');
    }

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

    if (onlyToggleRelay && typeof relayEnabled === 'boolean') {
      await callSidecar(
        '/v1/repos/patch',
        {
          id: repository.id,
          relayEnabled,
        },
        { label: 'publish-relay-only-patch' }
      );
      await publishFanout(repository.id, 'relay-toggle', { relayEnabledOverride: relayEnabled });

      return {
        alreadyPublic: repository.isPublic,
        relayEnabled,
        message: relayEnabled ? '已开启社区接力' : '已关闭社区接力',
      };
    }

    await requestImportPublication(repository.id, userId);
    if (repository.isPublic && repository.reviewStatus === 'APPROVED') {
      if (typeof relayEnabled === 'boolean' && relayEnabled !== repository.relayEnabled) {
        await callSidecar(
          '/v1/repos/patch',
          {
            id: repository.id,
            relayEnabled,
          },
          { label: 'publish-relay-toggle-patch' }
        );
        await publishFanout(repository.id, 'relay-toggle', { relayEnabledOverride: relayEnabled });

        return {
          alreadyPublic: true,
          relayEnabled,
          message: relayEnabled ? '已开启社区接力' : '已关闭社区接力',
        };
      }

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
      edition: repository.edition ?? '',
    });

    if (dedupInfo.existsInExplore && !repository.isPublic) {
      throw ApiError.conflict('探索广场中已存在该仓库的公开教程，不可重复发布。', {
        code: 'DUPLICATE_EXPLORE',
      });
    }

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
    // Always persist a deterministic fallback cluster key so homepage grouping never splits on null.
    if (adoptedClusterKey == null) {
      const fallbackKey = `${(repository.owner || '').toLowerCase()}/${(repository.repo || '').toLowerCase()}`;
      await callSidecar(
        '/v1/repos/patch',
        {
          id: repository.id,
          sourceClusterKey: fallbackKey,
        },
        { label: 'publish-cluster-fallback-patch' }
      ).catch(ignoreBestEffort);
    }

    const content = await getPublicationContent(prisma, repository.id, userId);
    if (!content.ready) {
      throw new ApiError(422, '该教程尚未完成文档转录解析，暂不可发布。', {
        code: 'INCOMPLETE_TRANSCRIPTION',
      });
    }

    const { checkPublishLicense } = await import('@/lib/review/license-gate');
    const webProfile = z.object({ sourceType: z.literal('web') }).safeParse(repository.repoProfile);
    const license = repository.owner === WEB_DOC_OWNER && webProfile.success
      ? { allowed: true, reason: undefined }
      : await checkPublishLicense({
          id: repository.id, owner: repository.owner, repo: repository.repo,
          repoProfile: repository.repoProfile,
        });
    if (!license.allowed) {
      throw new ApiError(422, license.reason ?? 'License check failed', { code: 'NO_LICENSE' });
    }

    const hasValidDoc = repository.documents.some(
      d => d.title && d.title.trim().length > 0
    );
    if (!hasValidDoc) {
      throw new ApiError(422, '教程文档内容缺失或结构异常，校验未通过。', {
        code: 'INVALID_CONTENT',
      });
    }

    const nowIso = new Date().toISOString();

    // Platform safety review uses neutral platform models rather than publisher BYOK to prevent self-approval.
    const [pipelineScore, llmReview, reviewConfig] = await Promise.all([
      computePipelineScore(repository.id),
      reviewTutorialByPlatform(repository.id, userId),
      prisma.platformReviewConfig.findUnique({ where: { id: 'singleton' } }).catch(() => { ignoreBestEffort(); return null; }),
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
    // Store null instead of synthetic 0 when LLM review is unavailable so missing channels do not tank ranking.
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
