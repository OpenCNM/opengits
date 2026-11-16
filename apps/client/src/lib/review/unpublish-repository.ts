import { revalidateTag } from 'next/cache';
import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/server/api-error';
import { isAdminRole } from '@/lib/tiers';
import { resolveMaintainerUserId } from '@/lib/repository-maintainer';
import { publicationSnapshot } from '@/lib/credits/import-reward';
import { callSidecar } from '@/lib/sidecar-client';
import { PUBLIC_HOME_CACHE_TAG } from '@/lib/home/public-home-data';
import { invalidateWebL1Projection } from '@/lib/docs/web-outline-projection';
import { notifyClientRevalidate } from './publish-fanout';
import type { UnpublishRepositoryResult } from '@/types/credits';

export interface UnpublishRepoParams {
  repoId?: string;
  owner?: string;
  repo?: string;
  edition?: string;
}

async function findTargetRepository(input: { repoId?: string; owner?: string; repo?: string; edition?: string }) {
  if (input.repoId) {
    return prisma.repository.findUnique({
      where: { id: input.repoId },
      select: {
        id: true,
        owner: true,
        repo: true,
        edition: true,
        isPublic: true,
        reviewPipeline: true,
        unpublishCooldownUntil: true,
        unpublishRequestedAt: true,
      },
    });
  }
  if (input.owner && input.repo) {
    return prisma.repository.findFirst({
      where: {
        owner: input.owner,
        repo: input.repo,
        ...(input.edition !== undefined ? { edition: input.edition } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        owner: true,
        repo: true,
        edition: true,
        isPublic: true,
        reviewPipeline: true,
        unpublishCooldownUntil: true,
        unpublishRequestedAt: true,
      },
    });
  }
  return null;
}

/**
 * 作者单向下架：
 * 1. 验证维护者/作者/管理员身份；
 * 2. 0 秒切换 isPublic = false 隐身；
 * 3. 作废该仓未解冻的 PendingCreditGrant 流水；
 * 4. 将读者已收藏的 SavedRepo.autoFollow 置为 false（保留为静态只读快照）；
 * 5. 联动清退主站缓存与 L1 投影。
 * 6. 后续可走标准正向发布通路重新提审发布。
 */
export async function unpublishRepository(
  userId: string,
  input: UnpublishRepoParams
): Promise<UnpublishRepositoryResult> {
  const repository = await findTargetRepository(input);
  if (!repository) {
    throw ApiError.notFound('未找到该仓库记录');
  }

  // 授权门禁：仅维护者、最早发布者或平台管理员可执行
  const maintainerId = await resolveMaintainerUserId(repository.id);
  const publication = publicationSnapshot(repository.reviewPipeline);
  const user = userId ? await prisma.user.findUnique({ where: { id: userId }, select: { role: true } }) : null;
  const isAuthorized = userId === maintainerId || userId === publication?.userId || isAdminRole(user?.role);
  if (!isAuthorized) {
    throw ApiError.forbidden('权限不足，仅教程维护者、发布者或管理员可申请下架');
  }

  if (!repository.isPublic) {
    throw ApiError.badRequest('该教程当前未公开，无需下架');
  }

  const sidecarRes = await callSidecar<{
    ok: boolean;
    isPublic: boolean;
    cancelledPendingGrantsCount: number;
    detachedSavedReposCount: number;
  }>(
    '/v1/repos/unpublish',
    {
      id: repository.id,
      userId,
    },
    { label: 'repo-unpublish' }
  );

  // 下架影响全站公共探索广场与推荐列表
  try {
    revalidateTag(PUBLIC_HOME_CACHE_TAG, 'max');
  } catch (err) {
    // 容错降级: 本实例 revalidate 失败不阻断下架流程（notifyClientRevalidate 跨实例广播兜底），留痕观测
    console.warn('[unpublish-repository] revalidateTag failed:', err);
  }
  invalidateWebL1Projection(repository.id);

  // 跨实例/跨进程广播失效通知（首页缓存与 L1/L2 大纲投影，多实例/admin 联动）
  await notifyClientRevalidate([PUBLIC_HOME_CACHE_TAG], [repository.id]);

  // 清除接力通知事实戳（经 Go patch——Repository 写权归 Go）：下架后重新发布时允许再次通知跟随者
  try {
    await callSidecar(
      '/v1/repos/patch',
      { id: repository.id, clearRelayNotifiedAt: true },
      { label: 'unpublish-clear-relay-notified' }
    );
  } catch (err) {
    console.warn('[unpublish] Failed to clear relayNotifiedAt:', err);
  }

  return {
    success: true,
    isPublic: false,
    cancelledPendingGrantsCount: sidecarRes.cancelledPendingGrantsCount,
    detachedSavedReposCount: sidecarRes.detachedSavedReposCount,
    message: '教程已下架并从广场隐身；未到期的待解冻贡献积分已自动作废，已收藏读者的项目已转为只读快照。',
  };
}

