import { prisma } from './db';

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

export async function verifyRepoAccessDirect(
 repo: { id: string; isPublic: boolean; savedRepos?: Array<{ userId: string }> },
 userId?: string
): Promise<boolean> {
 if (repo.isPublic) return true;
 if (!userId) return false;

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

export function docVisibilityFilter(userId?: string | null): { OR?: Array<{ ownerUserId: string | null }>; ownerUserId?: null } {
  const validUserId = typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null;
  return validUserId
    ? { OR: [{ ownerUserId: null }, { ownerUserId: validUserId }] }
    : { ownerUserId: null };
}
