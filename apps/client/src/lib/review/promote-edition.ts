import { revalidateTag, revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/server/api-error';
import { isAdminRole } from '@/lib/tiers';
import { resolveMaintainerUserId } from '@/lib/repository-maintainer';
import { publicationSnapshot } from '@/lib/credits/import-reward';
import { callSidecar } from '@/lib/sidecar-client';
import { PUBLIC_HOME_CACHE_TAG } from '@/lib/home/public-home-data';
import { invalidateWebL1Projection } from '@/lib/docs/web-outline-projection';
import { notifyClientRevalidate } from './publish-fanout';
import type { PromoteEditionInput } from '@/lib/schemas/credit-grant';
import type { PromoteEditionResult } from '@/types/credits';

export interface PromoteEditionParams extends PromoteEditionInput {}

async function findTargetRepository(input: PromoteEditionParams) {
  if (input.repoId) {
    return prisma.repository.findUnique({
      where: { id: input.repoId },
      select: {
        id: true,
        owner: true,
        repo: true,
        branch: true,
        edition: true,
        isPublic: true,
        reviewPipeline: true,
      },
    });
  }
  if (input.owner && input.repo && input.edition) {
    return prisma.repository.findFirst({
      where: {
        owner: { equals: input.owner, mode: 'insensitive' },
        repo: { equals: input.repo, mode: 'insensitive' },
        edition: input.edition,
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        owner: true,
        repo: true,
        branch: true,
        edition: true,
        isPublic: true,
        reviewPipeline: true,
      },
    });
  }
  return null;
}

/**
 * 版本晋升覆盖（Promote to Primary Edition）：
 * 1. 验证目标版本存在且为自定义讲法（edition !== ""）；
 * 2. 授权门禁：仅维护者、发布者、属主（文档或导入记录拥有者）或平台特权管理员可执行；
 * 3. 事务性下推 Worker-Sidecar：
 *    - 平滑迁移老读者的 SavedRepo 收藏至新版；
 *    - 级联清退旧的默认版本（edition === ""）；
 *    - 将目标新版本的 edition 重置为 ""，并置为 isPublic = true；
 * 4. 联动清退主站缓存、全网 L1 大纲投影与页面路径缓存。
 */
export async function promoteEditionRepository(
  userId: string,
  input: PromoteEditionParams
): Promise<PromoteEditionResult> {
  const repository = await findTargetRepository(input);
  if (!repository) {
    throw ApiError.notFound('未找到指定版本记录');
  }

  if (!repository.edition || repository.edition.trim() === '') {
    throw ApiError.badRequest('该版本已是默认主版本，无需晋升');
  }

  // 授权门禁判定：仅维护者、发布者、属主（持有 Document 或 ImportRecord）或特权管理员可执行。
  // 严禁放行普通书架收藏者（SavedRepo 非属权证据）。
  const [maintainerId, user, ownsDoc, ownsImport] = await Promise.all([
    resolveMaintainerUserId(repository.id),
    userId
      ? prisma.user.findUnique({ where: { id: userId }, select: { role: true, tier: true } })
      : null,
    userId
      ? prisma.document.findFirst({
          where: { repositoryId: repository.id, ownerUserId: userId },
          select: { id: true },
        })
      : null,
    userId
      ? prisma.importRecord.findFirst({
          where: { repositoryId: repository.id, userId },
          select: { id: true },
        })
      : null,
  ]);

  const publication = publicationSnapshot(repository.reviewPipeline);
  const isPrivileged = Boolean(user && (isAdminRole(user.role) || user.tier === 'ENTERPRISE'));
  const isContentOwner = Boolean(ownsDoc || ownsImport);

  const isAuthorized = isPrivileged || userId === maintainerId || userId === publication?.userId || isContentOwner;
  if (!isAuthorized) {
    throw ApiError.forbidden('权限不足，仅教程维护者、创建者或管理员可将其设为主版本');
  }

  const sidecarRes = await callSidecar<{
    ok: boolean;
    promotedRepoId: string;
    oldDefaultRepoId?: string;
    migratedSaves: number;
  }>(
    '/v1/repos/promote-edition',
    {
      id: repository.id,
      userId,
    },
    { label: 'repo-promote-edition' }
  );

  // 缓存与投影全面失效
  try {
    revalidateTag(PUBLIC_HOME_CACHE_TAG, 'max');
  } catch (err) {
    // 容错降级: 本实例 revalidate 失败不阻断晋升流程（notifyClientRevalidate 广播兜底），留痕观测
    console.warn('[promote-edition] revalidateTag failed:', err);
  }
  invalidateWebL1Projection(repository.id);
  if (sidecarRes.oldDefaultRepoId) {
    invalidateWebL1Projection(sidecarRes.oldDefaultRepoId);
  }
  invalidateWebL1Projection(`${repository.owner}/${repository.repo}`);

  try {
    revalidatePath(`/docs/${repository.owner}/${repository.repo}`, 'layout');
  } catch (err) {
    // 容错降级: 路径级 revalidate 失败不阻断晋升（广播兜底），留痕观测
    console.warn('[promote-edition] revalidatePath failed:', err);
  }

  // 跨实例/跨进程广播失效通知（首页缓存与两代仓库的 L1/L2 大纲投影）
  const revalidateRepoIds = [repository.id];
  if (sidecarRes.oldDefaultRepoId) {
    revalidateRepoIds.push(sidecarRes.oldDefaultRepoId);
  }
  await notifyClientRevalidate([PUBLIC_HOME_CACHE_TAG], revalidateRepoIds);

  return {
    success: true,
    repositoryId: repository.id,
    owner: repository.owner,
    repo: repository.repo,
    branch: repository.branch,
    oldDefaultRepoId: sidecarRes.oldDefaultRepoId,
    migratedSavesCount: sidecarRes.migratedSaves ?? 0,
    message: '已成功将该版本设为默认主版本，老读者已平滑迁移至新版本。',
  };
}
