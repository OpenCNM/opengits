import { prisma } from '@/lib/db';
import { searchRepositoryDocs, ChunkSearchResult, DocSearchUnavailableError } from './doc-search';

export interface BundleSearchResult {
  repositoryId: string;
  owner: string;
  repo: string;
  heading: string | null;
  content: string;
  title: string | null;
  path: string;
  similarity: number;
}

/**
 * Perform concurrent FTS search across all repositories within an McpBundle.
 * Features normalized scoring and multi-repository attribution.
 */
export async function searchBundleDocs(
  bundleId: string,
  query: string,
  limitPerRepo: number = 4,
  totalLimit: number = 10,
  contentTypes?: string[],
  locale?: string
): Promise<BundleSearchResult[]> {
  try {
    if (!bundleId || typeof bundleId !== 'string' || !query || typeof query !== 'string' || !query.trim()) {
      return [];
    }

    const safeLimitPerRepo = Math.max(1, Math.min(50, Math.floor(Number(limitPerRepo) || 4)));
    const safeTotalLimit = Math.max(1, Math.min(100, Math.floor(Number(totalLimit) || 10)));

    const bundle = await prisma.mcpBundle.findFirst({
      where: {
        OR: [{ id: bundleId }, { slug: bundleId }],
      },
      include: {
        repositories: {
          // 纵深防御：admin 暂停（mcpStatus=PAUSED）的仓不参与 Bundle 检索（与路由层过滤双保险）
          where: { mcpStatus: { not: 'PAUSED' } },
          select: {
            id: true,
            owner: true,
            repo: true,
          },
        },
      },
    });

    if (!bundle || !Array.isArray(bundle.repositories) || bundle.repositories.length === 0) {
      return [];
    }

    const repositories = bundle.repositories;
    const repoMap = new Map(repositories.map(r => [r.id, r]));
    const repositoryIds = repositories.map(r => r.id).filter(Boolean);

    if (repositoryIds.length === 0) {
      return [];
    }

    interface RankedResult {
      repositoryId: string;
      owner: string;
      repo: string;
      heading: string | null;
      content: string;
      title: string | null;
      path: string;
      similarity: number;
      rrfScore: number;
    }

    const repoPromises = repositoryIds.map(async (repoId) => {
      try {
        const repoMeta = repoMap.get(repoId)!;
        const docs = await searchRepositoryDocs(
          repoId,
          query,
          safeLimitPerRepo * 2,
          undefined,
          contentTypes,
          undefined,
          locale
        );

        return docs.map((d, index) => ({
          repositoryId: repoId,
          owner: repoMeta.owner,
          repo: repoMeta.repo,
          heading: d.heading,
          content: d.content,
          title: d.title,
          path: d.path,
          similarity: d.similarity,
          rrfScore: 1 / (60 + index + 1),
        }));
      } catch (err) {
        // 检索后端故障 fail-closed：上抛由端点转 isError（区别于单仓检索无命中的空结果）
        if (err instanceof DocSearchUnavailableError) throw err;
        console.warn(`Error processing repository ${repoId} in bundle search:`, err);
        return [];
      }
    });

    const allRepoResults = await Promise.all(repoPromises);
    const aggregatedResults: RankedResult[] = [];

    for (const results of allRepoResults) {
      aggregatedResults.push(...results);
    }

    // Sort globally by combined score (similarity + rrfScore)
    aggregatedResults.sort((a, b) => {
      const scoreA = a.similarity + a.rrfScore;
      const scoreB = b.similarity + b.rrfScore;
      return scoreB - scoreA;
    });

    // Enforce per-repo and total limits
    const repoCounts = new Map<string, number>();
    const finalResults: BundleSearchResult[] = [];

    for (const r of aggregatedResults) {
      const count = repoCounts.get(r.repositoryId) || 0;
      if (count >= safeLimitPerRepo) continue;

      repoCounts.set(r.repositoryId, count + 1);
      finalResults.push({
        repositoryId: r.repositoryId,
        owner: r.owner,
        repo: r.repo,
        heading: r.heading,
        content: r.content,
        title: r.title,
        path: r.path,
        similarity: r.similarity,
      });

      if (finalResults.length >= safeTotalLimit) break;
    }

    return finalResults;
  } catch (error) {
    console.error('Error in searchBundleDocs:', error);
    return [];
  }
}
