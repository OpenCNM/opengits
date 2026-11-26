import { prisma } from './db';

const DOC_INCLUDE = {
  repository: {
    select: {
      id: true,
      owner: true,
      repo: true,
      branch: true,
      isPublic: true,
      relayEnabled: true,
      gitSha: true,
      hasUpstreamUpdate: true,
      autoSyncEnabled: true,
      publishedAt: true,
      reviewStatus: true,
      rejectionReason: true,
      repoProfile: true,
      transcriptionModels: true,
    },
  },
  contentRef: { select: { content: true } },
} as const;

function queryDoc(where: { repository: { id: string }; ownerUserId: string | null; OR?: Array<{ path: string }> }) {
  return prisma.document.findFirst({ where, include: DOC_INCLUDE });
}

export type VisibleDoc = Awaited<ReturnType<typeof queryDoc>>;

export async function findVisibleDoc(
  repoWhere: { id: string },
  pathCandidates: string[],
  userId?: string | null
): Promise<VisibleDoc> {
  const paths = pathCandidates.filter(Boolean);
  if (paths.length === 0) return null;
  const orPaths = { OR: paths.map((p) => ({ path: p })) };

  if (userId) {
    const own = await prisma.document.findFirst({
      where: { repository: repoWhere, ownerUserId: userId, ...orPaths },
      include: DOC_INCLUDE,
    });
    if (own) return own;
  }
  return prisma.document.findFirst({
    where: { repository: repoWhere, ownerUserId: null, ...orPaths },
    include: DOC_INCLUDE,
  });
}
