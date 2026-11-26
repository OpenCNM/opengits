import { unstable_cache } from 'next/cache';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { SYSTEM_BATCH_TRANSCRIBER_USER_ID } from '@/lib/constants';
import type { McpHealth } from '@/lib/recommendation/score';

export const PUBLIC_HOME_CACHE_TAG = 'home:v2';

export type HomeSortKey = 'hot' | 'newest' | 'oldest' | 'az' | 'za';

export function normalizeHomeSort(input?: string | null): HomeSortKey {
  return input === 'newest' || input === 'oldest' || input === 'az' || input === 'za'
    ? input
    : 'hot';
}

const LANG_DOC_INCLUDE = {
  documents: {
    select: { path: true },
    where: {
      OR: [
        { path: { contains: 'zh' } },
        { path: { contains: 'en' } },
        { path: { contains: 'ja' } },
      ],
    },
    take: ENGINE_CONFIG.pagination.homeReposLimit,
  },
} satisfies Prisma.RepositoryInclude;

const PUBLIC_REPO_INCLUDE = {
  ...LANG_DOC_INCLUDE,
  _count: {
    select: {
      savedRepos: {
        where: {
          userId: { not: SYSTEM_BATCH_TRANSCRIBER_USER_ID },
        },
      },
      favoriteRepos: true,
      documents: true,
    },
  },
} satisfies Prisma.RepositoryInclude;

export type PublicHomeRepoRow = Prisma.RepositoryGetPayload<{
  include: typeof PUBLIC_REPO_INCLUDE;
}>;

export interface RelayParticipantSummary {
  userId: string;
  name: string | null;
  image: string | null;
  active: boolean;
}

export interface RelayRepoSummary {
  participants: RelayParticipantSummary[];
  inProgress: number;
}

export interface PublicHomeData {
  publicRepos: PublicHomeRepoRow[];
  docsByRepoBaseline: Record<string, Array<{ path: string; status: string }>>;
  chapterCountsByRepo: Record<string, number>;
  recScores: Record<string, number>;
  mcpHealthByRepo: Record<string, McpHealth>;
  relayByRepo: Record<string, RelayRepoSummary>;
  shelfFees: Record<string, number>;
}

async function queryPublicHomeData(sort: HomeSortKey): Promise<PublicHomeData> {
  const publicRepos = await prisma.repository.findMany({
    where: {
      isPublic: true,
      documents: { some: {} },
    },
    orderBy:
      sort === 'hot'
        ? [{ views: 'desc' }, { createdAt: 'desc' }]
        : { createdAt: 'desc' },
    take: ENGINE_CONFIG.pagination.homeMaxRepos,
    include: PUBLIC_REPO_INCLUDE,
  });

  const existingIdSet = new Set(publicRepos.map((r) => r.id));
  const distinctOwnerRepos = Array.from(
    new Set(publicRepos.map((r) => `${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`))
  ).map((key) => {
    const [owner, repo] = key.split('/');
    return { owner: { equals: owner, mode: 'insensitive' as const }, repo: { equals: repo, mode: 'insensitive' as const } };
  });
  const clusterKeys = Array.from(
    new Set(publicRepos.map((r) => r.sourceClusterKey).filter((k): k is string => Boolean(k && k.trim())))
  );

  const siblingOrConditions: Prisma.RepositoryWhereInput[] = [];
  if (distinctOwnerRepos.length > 0) {
    siblingOrConditions.push({ OR: distinctOwnerRepos });
  }
  if (clusterKeys.length > 0) {
    siblingOrConditions.push({ sourceClusterKey: { in: clusterKeys } });
  }

  let hydratedPublicRepos = publicRepos;
  if (siblingOrConditions.length > 0) {
    const siblingRepos = await prisma.repository.findMany({
      where: {
        isPublic: true,
        documents: { some: {} },
        id: { notIn: Array.from(existingIdSet) },
        OR: siblingOrConditions,
      },
      take: ENGINE_CONFIG.pagination.homeEditionHydrateMax,
      orderBy: [{ edition: 'asc' }, { updatedAt: 'desc' }],
      include: PUBLIC_REPO_INCLUDE,
    });
    if (siblingRepos.length > 0) {
      hydratedPublicRepos = [...publicRepos, ...siblingRepos];
    }
  }

  const repoIds = hydratedPublicRepos.map((r) => r.id);

  const activeOutlines = repoIds.length
    ? await prisma.tutorialOutline.findMany({
        where: { repositoryId: { in: repoIds }, isActive: true },
        select: {
          repositoryId: true,
          chapters: {
            orderBy: { teachingOrder: 'asc' },
            select: {
              id: true,
              nodes: {
                orderBy: { teachingOrder: 'asc' },
                select: {
                  documentId: true,
                  headingPath: true,
                  document: {
                    select: {
                      id: true,
                      path: true,
                      status: true,
                    },
                  },
                },
              },
            },
          },
        },
      })
    : [];

  const outlineRepoIdSet = new Set(activeOutlines.map((o) => o.repositoryId));
  const fallbackRepoIds = repoIds.filter((id) => !outlineRepoIdSet.has(id));

  const fallbackDocs = fallbackRepoIds.length
    ? await prisma.document.findMany({
        where: { repositoryId: { in: fallbackRepoIds }, ownerUserId: null },
        select: { repositoryId: true, path: true, status: true },
      })
    : [];

  const docsByRepoBaseline: Record<string, Array<{ path: string; status: string }>> = {};
  const chapterCountsByRepo: Record<string, number> = {};

  for (const outline of activeOutlines) {
    chapterCountsByRepo[outline.repositoryId] = outline.chapters.length;
    const list: Array<{ path: string; status: string }> = [];
    for (const chapter of outline.chapters) {
      for (const node of chapter.nodes) {
        if (node.document && node.document.path) {
          list.push({
            path: node.document.path,
            status: node.document.status || 'PROCESSED',
          });
        } else {
          list.push({
            path: node.headingPath || `node-${node.documentId || chapter.id}`,
            status: 'UNPROCESSED',
          });
        }
      }
    }
    docsByRepoBaseline[outline.repositoryId] = list;
  }

  for (const d of fallbackDocs) {
    if (!d || !d.repositoryId || !d.path) continue;
    (docsByRepoBaseline[d.repositoryId] ??= []).push({
      path: d.path,
      status: d.status || 'PROCESSED',
    });
  }

  for (const [rid, list] of Object.entries(docsByRepoBaseline)) {
    if (chapterCountsByRepo[rid] === undefined) {
      chapterCountsByRepo[rid] = list.length;
    }
  }

  const recScores: Record<string, number> = {};
  const mcpHealthByRepo: Record<string, McpHealth> = {};
  if (repoIds.length > 0) {
    const { fetchMcpHealthForRepos, computeRecommendationScore } = await import(
      '@/lib/recommendation/score'
    );
    const mcpHealth = await fetchMcpHealthForRepos(repoIds);
    for (const repo of hydratedPublicRepos) {
      const llmJson = repo.reviewLlm as Record<string, unknown> | null | undefined;
      const rawLlm = llmJson?.unavailable ? null : (llmJson?.overallScore as number | null | undefined);
      const normLlm =
        rawLlm != null ? (rawLlm <= 10 && rawLlm > 0 ? Math.round(rawLlm * 10) : rawLlm) : null;
      const health = mcpHealth.get(repo.id);
      if (health) {
        mcpHealthByRepo[repo.id] = health;
      }
      const score = computeRecommendationScore(
        {
          savedCount: repo._count?.savedRepos ?? 0,
          helpfulCount: repo.helpfulCount ?? 0,
          mcpCallCount: repo.mcpCallCount ?? 0,
          updatedAt: repo.updatedAt ?? new Date(0),
          reviewPipelineTotal: (repo.reviewPipeline as Record<string, unknown> | null)?.total as number | null ?? null,
          reviewLlmScore: normLlm,
        },
        health,
      );
      recScores[repo.id] = score.total;
    }
  }

  const relayByRepo: Record<string, RelayRepoSummary> = {};
  const relayRepoIds = hydratedPublicRepos.filter((r) => r.relayEnabled).map((r) => r.id);
  if (relayRepoIds.length > 0) {
    const relayJobs = await prisma.chapterUpdateJob.findMany({
      where: { repositoryId: { in: relayRepoIds }, status: { in: ['CLAIMED', 'TRIAL', 'SWAPPED'] } },
      select: { repositoryId: true, status: true, claimedBy: true },
    });
    const userIds = [...new Set(relayJobs.map((j) => j.claimedBy).filter((v): v is string => !!v))];
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, image: true } })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));
    for (const job of relayJobs) {
      const user = job.claimedBy ? userById.get(job.claimedBy) : undefined;
      if (!user) continue;
      const summary = (relayByRepo[job.repositoryId] ??= { participants: [], inProgress: 0 });
      if (job.status !== 'SWAPPED') summary.inProgress++;
      let participant = summary.participants.find((p) => p.userId === user.id);
      if (!participant) {
        participant = { userId: user.id, name: user.name, image: user.image, active: false };
        summary.participants.push(participant);
      }
      if (job.status !== 'SWAPPED') participant.active = true;
    }
    for (const summary of Object.values(relayByRepo)) {
      summary.participants.sort((a, b) => Number(b.active) - Number(a.active));
    }
  }

  const { getDynamicCreditsConfig } = await import('@/lib/credits-config');
  const { resolveEffectiveShelfFee } = await import('@/lib/credits/shelf-fee');
  const config = await getDynamicCreditsConfig();
  const shelfFees: Record<string, number> = {};
  for (const repo of hydratedPublicRepos) {
    const docCount =
      (repo as { documentCount?: number }).documentCount ??
      repo._count?.documents ??
      docsByRepoBaseline[repo.id]?.length ??
      0;
    shelfFees[repo.id] = resolveEffectiveShelfFee({
      shelfFeeOverride: repo.shelfFeeOverride,
      transcriptionCreditsEarned: repo.transcriptionCreditsEarned,
      shelfFeeMultiplier: config.shelfFeeMultiplier,
      docCount,
    });
  }

  return {
    publicRepos: hydratedPublicRepos,
    docsByRepoBaseline,
    chapterCountsByRepo,
    recScores,
    mcpHealthByRepo,
    relayByRepo,
    shelfFees,
  };
}

const cacheBySort = new Map<HomeSortKey, () => Promise<PublicHomeData>>();

function getCachedGetter(sort: HomeSortKey): () => Promise<PublicHomeData> {
  let getter = cacheBySort.get(sort);
  if (!getter) {
    getter = unstable_cache(
      () => queryPublicHomeData(sort),
      ['public-home-data-v6', sort],
      {
        tags: [PUBLIC_HOME_CACHE_TAG],
        revalidate: ENGINE_CONFIG.pagination.homeCacheTtlSeconds,
      },
    );
    cacheBySort.set(sort, getter);
  }
  return getter;
}

export async function getPublicHomeData(sortRaw?: string | null): Promise<PublicHomeData> {
  return getCachedGetter(normalizeHomeSort(sortRaw))();
}
