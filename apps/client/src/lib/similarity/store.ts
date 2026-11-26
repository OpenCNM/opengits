import { prisma } from '@/lib/db';
import { canonicalizeRepo } from '@/lib/repo-dedup';
import type { DetectionContext, SignalFeature, SkeletonFeature } from './types';
import { SKELETON_SIMILARITY_THRESHOLD } from './features';

export async function findPublicByGitSha(
  gitSha: string,
  exclude: { owner: string; repo: string },
  limit = 3
) {
  return prisma.repository.findMany({
    where: {
      gitSha,
      isPublic: true,
      NOT: {
        owner: { equals: exclude.owner, mode: 'insensitive' },
        repo: { equals: exclude.repo, mode: 'insensitive' },
      },
    },
    select: { id: true, owner: true, repo: true },
    take: limit,
  });
}

// `%` uses gin_trgm_ops without session GUC dependence; explicit similarity() filters exact matches.
export async function findPublicBySkeleton(
  skeleton: string,
  exclude: { owner: string; repo: string },
  limit = 3,
  threshold: number = SKELETON_SIMILARITY_THRESHOLD
): Promise<Array<{ id: string; owner: string; repo: string; similarity: number }>> {
  try {
    const rows = await prisma.$queryRaw<Array<{ id: string; owner: string; repo: string; sim: number }>>`
      SELECT "id", "owner", "repo", similarity("skeleton", ${skeleton}) AS sim
      FROM "Repository"
      WHERE "isPublic" = true
        AND "skeleton" IS NOT NULL
        AND "skeleton" % ${skeleton}
        AND similarity("skeleton", ${skeleton}) >= ${threshold}
        AND NOT (lower("owner") = ${exclude.owner.toLowerCase()} AND lower("repo") = ${exclude.repo.toLowerCase()})
      ORDER BY sim DESC
      LIMIT ${limit};
    `;
    return rows.map((r) => ({ id: r.id, owner: r.owner, repo: r.repo, similarity: Number(r.sim) }));
  } catch (err) {
    console.warn('[similarity/store] skeleton trgm query failed:', err);
    return [];
  }
}

export async function findPublicByCanonicalRepo(owner: string, repo: string) {
  const canonical = canonicalizeRepo(owner, repo);
  return prisma.repository.findFirst({
    where: {
      owner: { equals: canonical.owner, mode: 'insensitive' },
      repo: { equals: canonical.repo, mode: 'insensitive' },
      isPublic: true,
      documents: { some: {} },
    },
    select: { id: true, owner: true, repo: true },
  });
}

export async function getClusterKeyOf(repositoryId: string): Promise<string | null> {
  const row = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { sourceClusterKey: true, skeletonHash: true, owner: true, repo: true },
  });
  if (!row) return null;
  return row.sourceClusterKey ?? row.skeletonHash ?? `${row.owner}/${row.repo}`;
}
