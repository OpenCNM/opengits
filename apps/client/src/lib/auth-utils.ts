import { prisma } from './db';

/**
 * Checks if a user has access to a repository by ID.
 * - Public repositories are accessible to anyone (even guest users).
 * - Personal repositories require the user to have it on their personal shelf (savedRepos).

 */
export async function checkRepositoryAccess(repositoryId: string, userId?: string): Promise<boolean> {
 const repo = await prisma.repository.findUnique({
 where: { id: repositoryId },
 select: {
 id: true,
 isPublic: true,
 savedRepos: userId ? {
 where: { userId },
 select: { id: true }
 } : undefined
 }
 });

 if (!repo) return false;
 return verifyRepoAccessDirect(repo, userId);
}

/**
 * Checks access directly on a pre-fetched repository object to avoid redundant database calls.
 * repo.savedRepos 形状：调用方可传 `{ where: { userId } }` 预过滤后的数组。
 */
export async function verifyRepoAccessDirect(
 repo: { id: string; isPublic: boolean; savedRepos?: Array<{ userId: string }> },
 userId?: string
): Promise<boolean> {
 if (repo.isPublic) return true;
 if (!userId) return false;

 // Personal Shelf
 if (repo.savedRepos && Array.isArray(repo.savedRepos)) {
 return repo.savedRepos.length > 0;
 }
 const saved = await prisma.savedRepo.findFirst({
 where: {
 repositoryId: repo.id,
 userId,
 },
 select: { id: true },
 });
 return !!saved;
}

/**
 * Checks if a user has access to a document by document ID.
 * 文档归属校验（真冻结）：私有文档（ownerUserId 非空）仅归属者可访问；
 * 共享文档（ownerUserId IS NULL）按仓库访问规则放行。
 */
export async function checkDocumentAccess(documentId: string, userId?: string): Promise<boolean> {
  if (!documentId) return false;
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { repositoryId: true, ownerUserId: true },
  });

  if (!doc) return false;
  const validUserId = typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : undefined;
  if (doc.ownerUserId && doc.ownerUserId !== validUserId) return false;
  return checkRepositoryAccess(doc.repositoryId, validUserId);
}

/**
 * 文档可见性过滤（真冻结统一读取规则）：
 * 登录用户 → 自己的私有副本 + 共享文档（ownerUserId IS NULL OR = userId）；
 * 游客 → 仅共享文档。
 * 用于所有按仓库读取文档的查询（docs 页 / 队列 / 搜索 / MCP 等）。
 */
export function docVisibilityFilter(userId?: string | null): { OR?: Array<{ ownerUserId: string | null }>; ownerUserId?: null } {
  const validUserId = typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null;
  return validUserId
    ? { OR: [{ ownerUserId: null }, { ownerUserId: validUserId }] }
    : { ownerUserId: null };
}
