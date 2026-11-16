import { z } from 'zod';
import { prisma } from '@/lib/db';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { reviewTutorialByUser } from '@/lib/review/user-review';
import {
  createReviewHistoryItem,
  appendReviewHistory,
  extractHistoricalContext,
} from '@/lib/review/history';
import { callSidecar } from '@/lib/sidecar-client';

const ReReviewInputSchema = z.object({
  repositoryId: z.string().optional(),
  owner: z.string().optional(),
  repo: z.string().optional(),
  edition: z.string().optional(),
  appealFocus: z.string().optional(),
});

export const POST = defineRoute({
  scope: 'POST /api/repos/re-review',
  auth: 'user',
  rateLimit: {
    limit: 6,
    windowMs: 3_600_000,
    identifier: ({ userId }) => `re-review:${userId ?? 'anonymous'}`,
  },
  bodySchema: ReReviewInputSchema,
  handler: async ({ body, userId }) => {
    if (!userId) throw ApiError.unauthorized();

    // 1. 定位目标 Repository
    let targetRepo: any = null;
    if (body.repositoryId) {
      targetRepo = await prisma.repository.findUnique({
        where: { id: body.repositoryId },
        include: {
          importRecords: {
            where: { userId },
            select: { id: true, userId: true },
          },
        },
      });
    } else if (body.owner && body.repo) {
      const edition = body.edition ?? '';
      targetRepo = await prisma.repository.findFirst({
        where: {
          owner: { equals: body.owner.trim(), mode: 'insensitive' },
          repo: { equals: body.repo.trim(), mode: 'insensitive' },
          edition: edition === '' ? '' : edition,
        },
        include: {
          importRecords: {
            where: { userId },
            select: { id: true, userId: true },
          },
        },
      });
    }

    if (!targetRepo) {
      throw ApiError.notFound('未找到对应的教程版本');
    }

    // 2. 鉴权：必须是维护者/创建者/属主
    const profile = (targetRepo.repoProfile ?? {}) as Record<string, unknown>;
    const isOwner =
      targetRepo.importRecords?.length > 0 ||
      (typeof profile.creatorId === 'string' && profile.creatorId === userId) ||
      (typeof profile.userId === 'string' && profile.userId === userId);

    if (!isOwner) {
      throw ApiError.forbidden('仅教程所有者或维护者拥有申请重评权限');
    }

    // 3. 校验剩余申诉机会 (一共 3 次机会)
    const remaining =
      typeof profile.reviewAppealsRemaining === 'number'
        ? profile.reviewAppealsRemaining
        : 3;

    if (remaining <= 0) {
      throw ApiError.badRequest('该版本已达申请重新评分的上限次数（最多 3 次机会）');
    }

    // 4. 提取历史审评基线与本次诉求，确保评分有据可依，不突然跑偏
    const historicalContext = extractHistoricalContext(
      targetRepo.reviewLlm,
      'owner_manual',
      body.appealFocus
    );

    // 5. 执行所有者大模型重评（严格走所有者个人 Token 流量）
    const userReviewRes = await reviewTutorialByUser(targetRepo.id, userId, {
      appealFocus: body.appealFocus,
      historicalContext,
    });

    const newReview = userReviewRes.review;
    if (newReview.unavailable) {
      throw ApiError.badRequest(newReview.concerns?.[0] || '重评通道暂不可用，请稍后重试');
    }

    // 6. 构造审评审计轨迹与原因记录
    const previousScore =
      typeof targetRepo.reviewLlm === 'object' && targetRepo.reviewLlm !== null
        ? ((targetRepo.reviewLlm as Record<string, unknown>).overallScore as number | undefined)
        : undefined;

    const historyItem = createReviewHistoryItem({
      trigger: 'owner_manual',
      operatorId: userId,
      operatorRole: 'owner',
      keyOrigin: 'user',
      model: userReviewRes.model,
      provider: userReviewRes.provider,
      previousScore,
      newScore: newReview.overallScore,
      reason: body.appealFocus?.trim() || '所有者对当前教学画像提出复核诉求',
      reviewResult: newReview,
    });

    const nextRemaining = remaining - 1;
    const updatedProfile = appendReviewHistory(
      {
        ...profile,
        reviewAppealsRemaining: nextRemaining,
        lastAppealedAt: historyItem.timestamp,
        lastAppealFocus: historyItem.reason,
      },
      historyItem
    );

    await callSidecar(
      '/v1/repos/patch',
      {
        id: targetRepo.id,
        reviewLlm: newReview,
        repoProfile: updatedProfile,
        touchReviewedAt: true,
      },
      { label: 're-review-repo-patch' }
    );

    return ok({
      success: true,
      reviewLlm: newReview,
      reviewAppealsRemaining: nextRemaining,
      overallScore: newReview.overallScore,
      historyItem,
      message: `重评已完成，当前评分 ${newReview.overallScore} 分，已记录审评过程与原因，消耗个人模型流量`,
    });
  },
});
