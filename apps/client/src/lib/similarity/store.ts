import { prisma } from '@/lib/db';
import { canonicalizeRepo } from '@/lib/repo-dedup';
import type { DetectionContext, SignalFeature, SkeletonFeature } from './types';
import { SKELETON_SIMILARITY_THRESHOLD } from './features';

/**
 * 相似度域的持久化与语料查询层：SQL 细节的唯一居所。
 * 检测器不直接接触 Prisma——换存储/索引策略只改本文件。
 */

/** gitSha 等值命中（懒惰 clone：clone+push 保留历史 → HEAD sha 与上游一致） */
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

/**
 * 骨架 trgm 相似命中：
 * - `%` 操作符走 gin_trgm_ops 索引粗筛（连接池下不依赖会话级 GUC，用默认阈值剪枝）
 * - `similarity() >= 阈值` 显式精筛保证正确性（索引剪枝只影响性能不影响结果）
 */
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

/** fork 上游的公开教程命中（复用 canonicalize 归一，与发布判重同口径） */
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

/** 读取行的簇键（归簇采纳时查被命中行的现有簇） */
export async function getClusterKeyOf(repositoryId: string): Promise<string | null> {
  const row = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { sourceClusterKey: true, skeletonHash: true, owner: true, repo: true },
  });
  if (!row) return null;
  return row.sourceClusterKey ?? row.skeletonHash ?? `${row.owner}/${row.repo}`;
}
