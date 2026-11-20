import { z } from 'zod';
import { prisma } from '@/lib/db';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';
import { getDynamicCreditsConfig } from '@/lib/credits-config';
import {
  chargeShelfFeeAndSave,
  isShelfFeeExempt,
  resolveEffectiveShelfFee,
} from '@/lib/credits/shelf-fee';

export const dynamic = 'force-dynamic';

const ApplyStarterPacksSchema = z
  .object({
    skip: z.boolean().optional(),
    bundleIds: z.array(z.string().min(1)).max(20).optional(),
    repositoryIds: z.array(z.string().min(1)).max(80).optional(),
    primaryProgLang: z.string().max(40).optional(),
  })
  .refine((data) => data.skip === true || (data.bundleIds && data.bundleIds.length > 0), {
    message: 'bundleIds is required unless skip is true',
  });

export const POST = defineRoute({
  scope: 'POST /api/user/starter-packs/apply',
  auth: 'user',
  bodySchema: ApplyStarterPacksSchema,
  handler: async ({ body, userId }) => {
    if (!userId) throw ApiError.unauthorized();

    // 1. 跳过引导：仅置位 hasPreferencesSet = true，不写入任何仓库
    if (body.skip) {
      await callSidecar(
        '/v1/user/preferences/set',
        { userId },
        { label: 'starter-packs skip preferences' }
      );
      return ok({ skipped: true, addedRepoIds: [] as string[] });
    }

    const requestedBundleIds = Array.from(new Set(body.bundleIds || []));
    const bundles = await prisma.mcpBundle.findMany({
      where: {
        id: { in: requestedBundleIds },
        isStarterPack: true,
        isPinned: true,
      },
      include: {
        repositories: {
          where: {
            isPublic: true,
            mcpStatus: { not: 'PAUSED' },
          },
          select: {
            id: true,
            shelfFeeOverride: true,
            transcriptionCreditsEarned: true,
            _count: { select: { documents: true } },
          },
        },
      },
    });

    if (bundles.length === 0) {
      throw ApiError.notFound('No active starter packs found');
    }

    // 2. 收集候选仓库并按 repositoryId 去重；若前端传入了微调后的 repositoryIds，严格取包内交集
    const allowedRepoFilter = body.repositoryIds
      ? new Set(body.repositoryIds)
      : null;

    const candidateRepos = new Map<
      string,
      {
        id: string;
        shelfFeeOverride: number | null;
        transcriptionCreditsEarned: number;
        docCount: number;
      }
    >();

    for (const bundle of bundles) {
      for (const r of bundle.repositories) {
        if (allowedRepoFilter && !allowedRepoFilter.has(r.id)) continue;
        if (!candidateRepos.has(r.id)) {
          candidateRepos.set(r.id, {
            id: r.id,
            shelfFeeOverride: r.shelfFeeOverride,
            transcriptionCreditsEarned: r.transcriptionCreditsEarned,
            docCount: r._count?.documents ?? 0,
          });
        }
      }
    }

    // 3. 免费门禁 + 幂等入架：仅装入有效书架费 === 0 或用户本人豁免的教程
    const creditsConfig = await getDynamicCreditsConfig();
    const addedRepoIds: string[] = [];

    for (const repo of candidateRepos.values()) {
      const fee = resolveEffectiveShelfFee({
        shelfFeeOverride: repo.shelfFeeOverride,
        transcriptionCreditsEarned: repo.transcriptionCreditsEarned,
        shelfFeeMultiplier: creditsConfig.shelfFeeMultiplier,
        docCount: repo.docCount,
      });

      if (fee > 0) {
        const exempt = await isShelfFeeExempt(userId, repo.id);
        if (!exempt) {
          continue;
        }
      }

      const result = await chargeShelfFeeAndSave(userId, repo.id, true);
      if (result.ok && !result.alreadySaved) {
        addedRepoIds.push(repo.id);
      }
    }

    // 4. 更新场景包使用计数 & 记录用户偏好（置位 hasPreferencesSet = true）
    const industrySummary = bundles
      .map((b) => b.starterCategory || b.title)
      .filter(Boolean)
      .slice(0, 3)
      .join(', ');

    await Promise.all([
      ...bundles.map((b) =>
        callSidecar(
          '/v1/mcp/bundles/use',
          { bundleId: b.id },
          { label: 'starter-packs bundle use' }
        ).catch((err) => {
          // 容错降级: 场景包使用计数递增失败不阻断用户装配主流程
          console.warn('[starter-packs/apply] increment bundle use failed:', err);
          return null;
        })
      ),
      callSidecar(
        '/v1/user/preferences/set',
        {
          userId,
          industry: industrySummary || undefined,
          primaryProgLang: body.primaryProgLang?.trim() || undefined,
        },
        { label: 'starter-packs set preferences' }
      ),
    ]);

    return ok({
      skipped: false,
      addedRepoIds,
      appliedBundleIds: bundles.map((b) => b.id),
    });
  },
});
