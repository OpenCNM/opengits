import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { resolveRepository, ResolvedRepositoryResult } from '@/lib/repository-resolver';
import { repositoryDocsInclude } from './repo-tools';
import { TtlCache } from '@/lib/cache/ttl-cache';

// Caches repo metadata (including null misses) for 60s TTL; auth, bans, quotas, and doc bodies bypass cache. Callers must not mutate rows.

const resolveCache = new TtlCache<ResolvedRepositoryResult | null>();

export async function resolveRepositoryMcpCached(
  owner: string,
  repo: string,
  versionOrBranch?: string,
  edition?: string,
  userId?: string | null
): Promise<ResolvedRepositoryResult | null> {
  const key = JSON.stringify([owner, repo, versionOrBranch ?? '', edition ?? '', userId ?? '']);
  return resolveCache.getOrLoad(key, () =>
    resolveRepository(owner, repo, versionOrBranch, edition, repositoryDocsInclude(userId))
  );
}

const routeCheckCache = new TtlCache<Awaited<ReturnType<typeof prisma.repository.findFirst>>>();

export async function cachedDefaultBranchRepository(owner: string, repo: string) {
  return routeCheckCache.getOrLoad(JSON.stringify([owner, repo]), async () => {
    const primary = await prisma.repository.findFirst({
      where: { owner, repo, branch: ENGINE_CONFIG.defaultBranch },
    });
    if (primary) return primary;
    return prisma.repository.findFirst({
      where: { owner, repo },
      orderBy: { updatedAt: 'desc' },
    });
  });
}
