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

  // Require maintainer, publisher, owner, or admin; SavedRepo bookmarks do not grant ownership.
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

  try {
    revalidateTag(PUBLIC_HOME_CACHE_TAG, 'max');
  } catch (err) {
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
    console.warn('[promote-edition] revalidatePath failed:', err);
  }

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
