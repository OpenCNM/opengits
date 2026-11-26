import { prisma } from '@/lib/db';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';

export type RepoDeleteDecision =
  | 'GLOBAL_DELETE'
  | 'PERSONAL_UNSAVE'
  | 'FORBIDDEN'
  | 'CONFLICT_PENDING_REVIEW'
  | 'CONFLICT_ACTIVE_IMPORT'
  | 'CONFLICT_EXTERNAL_USERS';

export interface RepoDeleteDecisionInput {
  actor: { role: string; tier: string } | null;
  isPrivileged: boolean;
  repoIsPublic: boolean;
  reviewStatus?: string | null;
  globalDelete: boolean;
  isMaintainerOrSoleOwner: boolean;
  actorHasSavedRepo: boolean;
  hasExternalUsers: boolean;
  hasActiveImportJob: boolean;
}

// Public repos are community assets: only admins/ENTERPRISE delete globally while others unsave locally.
export function decideRepoDeleteAction(input: RepoDeleteDecisionInput): RepoDeleteDecision {
  if (!input.actor) return 'FORBIDDEN';

  if (input.repoIsPublic) {
    if (!input.globalDelete) return 'PERSONAL_UNSAVE';
    return input.isPrivileged ? 'GLOBAL_DELETE' : 'FORBIDDEN';
  }

  if (input.isPrivileged) {
    if (!input.globalDelete && !input.isMaintainerOrSoleOwner && input.actorHasSavedRepo) {
      return 'PERSONAL_UNSAVE';
    }
    return 'GLOBAL_DELETE';
  }

  if (!input.isMaintainerOrSoleOwner) {
    if (!input.globalDelete && input.actorHasSavedRepo) {
      return 'PERSONAL_UNSAVE';
    }
    return 'FORBIDDEN';
  }

  if (input.reviewStatus === 'PENDING') {
    return 'CONFLICT_PENDING_REVIEW';
  }
  if (input.hasActiveImportJob) {
    return 'CONFLICT_ACTIVE_IMPORT';
  }
  if (input.hasExternalUsers) {
    return 'CONFLICT_EXTERNAL_USERS';
  }
  return 'GLOBAL_DELETE';
}

export interface RepoDeleteAuthInput {
  actor: { role: string; tier: string } | null;
  isPrivileged: boolean;
  repoIsPublic: boolean;
  ownsPrivateDocs: boolean;
  globalDelete: boolean;
  reviewStatus?: string | null;
  hasExternalUsers?: boolean;
  hasActiveImportJob?: boolean;
}

export function canGloballyDeleteRepo(input: RepoDeleteAuthInput): boolean {
  if (!input.actor) return false;
  if (input.isPrivileged) return true;
  if (input.repoIsPublic) return false;
  if (input.reviewStatus === 'PENDING' || input.hasActiveImportJob || input.hasExternalUsers) {
    return false;
  }
  return input.ownsPrivateDocs;
}

export interface RepoDeleteFacts {
  isMaintainerOrSoleOwner: boolean;
  actorHasSavedRepo: boolean;
  hasExternalUsers: boolean;
  hasActiveImportJob: boolean;
}

export async function inspectRepoDeleteFacts(
  repositoryId: string,
  userId: string,
  tuple: { owner: string; repo: string; branch: string; edition: string }
): Promise<RepoDeleteFacts> {
  const [
    earliestImport,
    ownDoc,
    ownSaved,
    extSaved,
    extDoc,
    extImport,
    extVersion,
    activeJob,
  ] = await Promise.all([
    prisma.importRecord.findFirst({
      where: { repositoryId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { userId: true },
    }),
    prisma.document.findFirst({
      where: { repositoryId, ownerUserId: userId },
      select: { id: true },
    }),
    prisma.savedRepo.findFirst({
      where: { repositoryId, userId },
      select: { id: true },
    }),
    prisma.savedRepo.findFirst({
      where: { repositoryId, userId: { not: userId } },
      select: { id: true },
    }),
    prisma.document.findFirst({
      where: { repositoryId, ownerUserId: { not: null, notIn: [userId] } },
      select: { id: true },
    }),
    prisma.importRecord.findFirst({
      where: { repositoryId, userId: { not: userId } },
      select: { id: true },
    }),
    prisma.chapterVersion.findFirst({
      where: { repositoryId, authorId: { not: userId } },
      select: { id: true },
    }),
    prisma.importJob.findFirst({
      where: {
        owner: tuple.owner,
        repo: tuple.repo,
        branch: tuple.branch,
        edition: tuple.edition,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      select: { id: true },
    }),
  ]);

  const hasExternalUsers = Boolean(extSaved || extDoc || extImport || extVersion);
  const isMaintainerOrSoleOwner = earliestImport
    ? earliestImport.userId === userId
    : Boolean(ownDoc || (ownSaved && !extSaved));
  return {
    isMaintainerOrSoleOwner,
    actorHasSavedRepo: Boolean(ownSaved),
    hasExternalUsers,
    hasActiveImportJob: Boolean(activeJob),
  };
}

export async function userOwnsPrivateDocs(repositoryId: string, userId: string): Promise<boolean> {
  const [earliestImport, owned, saved, extSaved] = await Promise.all([
    prisma.importRecord.findFirst({
      where: { repositoryId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { userId: true },
    }),
    prisma.document.findFirst({
      where: { repositoryId, ownerUserId: userId },
      select: { id: true },
    }),
    prisma.savedRepo.findFirst({
      where: { repositoryId, userId },
      select: { id: true },
    }),
    prisma.savedRepo.findFirst({
      where: { repositoryId, userId: { not: userId } },
      select: { id: true },
    }),
  ]);

  if (earliestImport) {
    return earliestImport.userId === userId;
  }
  if (owned) return true;
  return Boolean(saved && !extSaved);
}

export interface DeleteRepositoryInput {
  id?: string | null;
  owner?: string | null;
  repo?: string | null;
  globalDelete?: boolean;
}

export interface DeleteRepositoryResult {
  action: 'GLOBAL_DELETE' | 'PERSONAL_UNSAVE';
  message: string;
}

export async function deleteRepositoryForUser(
  userId: string,
  input: DeleteRepositoryInput
): Promise<DeleteRepositoryResult> {
  if (!userId) throw ApiError.unauthorized();

  const id = input.id?.trim() || undefined;
  const owner = input.owner?.trim() || undefined;
  const repoName = input.repo?.trim() || undefined;
  const globalDelete = Boolean(input.globalDelete);

  if (!id && (!owner || !repoName)) {
    throw ApiError.badRequest('Repository ID or owner/repo is required');
  }

  const repo = id
    ? await prisma.repository.findUnique({
        where: { id },
        select: { id: true, isPublic: true, owner: true, repo: true, branch: true, edition: true, reviewStatus: true },
      })
    : await prisma.repository.findFirst({
        where: { owner: owner!, repo: repoName! },
        select: { id: true, isPublic: true, owner: true, repo: true, branch: true, edition: true, reviewStatus: true },
      });

  if (!repo) {
    throw ApiError.notFound('Repository not found');
  }

  const actor = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, tier: true },
  });
  const { isAdminRole } = await import('@/lib/tier-limits');
  const isPrivileged = Boolean(actor && (isAdminRole(actor.role) || actor.tier === 'ENTERPRISE'));
  const facts = await inspectRepoDeleteFacts(repo.id, userId, {
    owner: repo.owner,
    repo: repo.repo,
    branch: repo.branch,
    edition: repo.edition,
  });

  const decision = decideRepoDeleteAction({
    actor,
    isPrivileged,
    repoIsPublic: repo.isPublic,
    reviewStatus: repo.reviewStatus,
    globalDelete,
    ...facts,
  });

  switch (decision) {
    case 'PERSONAL_UNSAVE': {
      await callSidecar(
        '/v1/repos/unsave',
        { userId, repositoryId: repo.id },
        { label: 'repos-unsave' }
      );
      const { invalidateWebL1Projection } = await import('@/lib/docs/web-outline-projection');
      invalidateWebL1Projection(repo.id);
      invalidateWebL1Projection(`${repo.owner}/${repo.repo}`);
      try {
        const { revalidatePath } = await import('next/cache');
        revalidatePath(`/docs/${repo.owner}/${repo.repo}`, 'layout');
      } catch (err) {
        console.warn('[repos delete] revalidatePath failed on personal unsave:', err);
      }
      return {
        action: 'PERSONAL_UNSAVE',
        message: 'Repository removed from your shelf',
      };
    }
    case 'FORBIDDEN':
      throw ApiError.forbidden('无权删除该仓库：公开仓删除需管理员；私有仓仅维护者或管理员可删除');
    case 'CONFLICT_PENDING_REVIEW':
      throw ApiError.conflict('该教程正在审核中，请先撤回提审后再删除');
    case 'CONFLICT_ACTIVE_IMPORT':
      throw ApiError.conflict('该教程正在导入构建中，请等待完成或中止后再删除');
    case 'CONFLICT_EXTERNAL_USERS':
      throw ApiError.conflict('该教程存在其他用户的书架快照或协作贡献记录，无法物理删除');
    case 'GLOBAL_DELETE': {
      await callSidecar(
        '/v1/repos/delete',
        { id: repo.id },
        { label: 'repos-global-delete' }
      );

      const { maybePruneRepoAssetDir } = await import('@/lib/storage/assets-gc');
      maybePruneRepoAssetDir(repo.owner, repo.repo);

      const { invalidateWebL1Projection } = await import('@/lib/docs/web-outline-projection');
      invalidateWebL1Projection(repo.id);
      invalidateWebL1Projection(`${repo.owner}/${repo.repo}`);

      const { PUBLIC_HOME_CACHE_TAG } = await import('@/lib/home/public-home-data');
      try {
        const { revalidateTag } = await import('next/cache');
        revalidateTag(PUBLIC_HOME_CACHE_TAG, 'max');
      } catch (err) {
        console.warn('[repos delete] revalidateTag failed:', err);
      }
      const { notifyClientRevalidate } = await import('@/lib/review/publish-fanout');
      await notifyClientRevalidate([PUBLIC_HOME_CACHE_TAG], [repo.id]);

      return {
        action: 'GLOBAL_DELETE',
        message: 'Repository deleted globally from database',
      };
    }
  }
}
