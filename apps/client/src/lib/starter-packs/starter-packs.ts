import { prisma } from '@/lib/db';
import { getDynamicCreditsConfig } from '@/lib/credits-config';
import { resolveEffectiveShelfFee } from '@/lib/credits/shelf-fee';

export interface StarterPackRepoItem {
  id: string;
  owner: string;
  repo: string;
  branch: string;
  category: string | null;
  docCount: number;
  isSaved: boolean;
}

export interface StarterPackItem {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  badge: string;
  starterCategory: string | null;
  repos: StarterPackRepoItem[];
}

export interface StarterPacksListResult {
  packs: StarterPackItem[];
  hasPreferencesSet: boolean;
}

export async function listFreeStarterPacks(
  userId?: string | null
): Promise<StarterPacksListResult> {
  const [bundles, creditsConfig, userRow] = await Promise.all([
    prisma.mcpBundle.findMany({
      where: {
        isStarterPack: true,
        isPinned: true,
      },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
      include: {
        repositories: {
          where: {
            isPublic: true,
            mcpStatus: { not: 'PAUSED' },
          },
          select: {
            id: true,
            owner: true,
            repo: true,
            branch: true,
            category: true,
            shelfFeeOverride: true,
            transcriptionCreditsEarned: true,
            _count: {
              select: { documents: true },
            },
          },
        },
      },
    }),
    getDynamicCreditsConfig(),
    userId
      ? prisma.user.findUnique({
          where: { id: userId },
          select: {
            hasPreferencesSet: true,
            savedRepos: {
              select: { repositoryId: true },
            },
          },
        })
      : Promise.resolve(null),
  ]);

  const savedIdSet = new Set(
    (userRow?.savedRepos || []).map((sr) => sr.repositoryId)
  );

  const packs: StarterPackItem[] = [];
  for (const bundle of bundles) {
    const freeRepos: StarterPackRepoItem[] = [];
    for (const r of bundle.repositories) {
      const docCount = r._count?.documents ?? 0;
      const fee = resolveEffectiveShelfFee({
        shelfFeeOverride: r.shelfFeeOverride,
        transcriptionCreditsEarned: r.transcriptionCreditsEarned,
        shelfFeeMultiplier: creditsConfig.shelfFeeMultiplier,
        docCount,
      });
      if (fee === 0) {
        freeRepos.push({
          id: r.id,
          owner: r.owner,
          repo: r.repo,
          branch: r.branch,
          category: r.category,
          docCount,
          isSaved: savedIdSet.has(r.id),
        });
      }
    }

    if (freeRepos.length > 0) {
      packs.push({
        id: bundle.id,
        slug: bundle.slug,
        title: bundle.title,
        description: bundle.description,
        badge: bundle.badge || '❖ 官方精选',
        starterCategory: bundle.starterCategory,
        repos: freeRepos,
      });
    }
  }

  return {
    packs,
    hasPreferencesSet: Boolean(userRow?.hasPreferencesSet),
  };
}
