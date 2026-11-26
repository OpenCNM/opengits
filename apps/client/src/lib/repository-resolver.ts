import { cache } from 'react';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { resolveTranscriptionPreset } from '@/lib/transcription-presets';
import { docVisibilityFilter } from '@/lib/auth-utils';

export {
  isWebDocRepository,
  isNativeWebDocMirror,
  resolveRepositoryDisplayName,
  resolveLocalizedRepoDescription,
  extractWebDocOrigin,
  isGenericWebDocTitle,
} from '@/lib/repository-origin';

export function resolveDocLiveUrl(
  navTree: unknown,
  docPath: string,
  fallbackRootUrl?: string | null
): string | null {
  if (!Array.isArray(navTree) || !docPath) return fallbackRootUrl || null;
  const target = docPath.toLowerCase().replace(/\.mdx?$/, '');

  function walk(nodes: any[]): string | null {
    for (const node of nodes) {
      if (node && typeof node === 'object') {
        if (node.path) {
          const nodePath = String(node.path).toLowerCase().replace(/\.mdx?$/, '');
          if (nodePath === target && typeof node.sourceUrl === 'string' && node.sourceUrl.trim()) {
            return node.sourceUrl.trim();
          }
        }
        if (Array.isArray(node.children)) {
          const found = walk(node.children);
          if (found) return found;
        }
      }
    }
    return null;
  }

  return walk(navTree) || fallbackRootUrl || null;
}

export interface RepositoryVersionOption {
  branch: string;
  semVerLabel: string | null;
  isDefault: boolean;
  label: string;
}

export interface RepositoryEditionOption {
  id: string;
  edition: string;
  label: string;
  presetId: string | null;
  isDefault: boolean;
  branch: string;
  isPublic: boolean;
  transcriptionModels?: string[];
  createdAt?: string;
  updatedAt?: string;
  chapterCount?: number;
  processedDocsCount?: number;
  creatorName?: string | null;
  isCurrentUserCreator?: boolean;
  wordCount?: number;
  teachingDepth?: string;
  relayEnabled?: boolean;
  isFullyTranscribed?: boolean;
  reviewPipeline?: unknown;
  reviewLlm?: unknown;
  reviewAppealsRemaining?: number;
  relay?: {
    total: number;
    done: number;
    inProgress: number;
    participants?: Array<{
      userId?: string;
      name?: string | null;
      image?: string | null;
      active?: boolean;
    }>;
  } | null;
}

export interface ResolvedRepositoryResult {
  repository: any;
  resolvedBranch: string;
  targetVersionLabel?: string;
  isFallback: boolean;
  resolvedEdition: string;
  // Present when an explicit edition is missing so mutating endpoints fail closed instead of targeting base.
  editionMiss?: { requested: string };
}

const BASE_EDITION_LABEL = '标准教程';

export function editionParamFromUrl(request: Request | { nextUrl?: URL }): string {
  try {
    const url = (request as Request).url ? new URL((request as Request).url) : (request as { nextUrl?: URL }).nextUrl;
    if (!url) return '';
    return url.searchParams.get('edition') ?? '';
  } catch {
    return '';
  }
}

export function deriveEditionLabel(
  repoProfile: unknown,
  transcriptionModels?: string[] | null
): string {
  const modelFromArgs = transcriptionModels?.[0]?.trim() || '';
  const profile =
    repoProfile && typeof repoProfile === 'object'
      ? (repoProfile as Record<string, unknown>)
      : null;

  if (profile) {
    if (typeof profile.editionLabel === 'string' && profile.editionLabel.trim() !== '') {
      const trimmed = profile.editionLabel.trim();
      if (
        !/^讲法\s+/i.test(trimmed) &&
        !/^ed_[a-z0-9_]+$/i.test(trimmed) &&
        trimmed !== '标准教程' &&
        trimmed !== '默认' &&
        trimmed !== '教学解读版' &&
        trimmed !== '教学解读'
      ) {
        return trimmed;
      }
    }
  }

  const profileModel =
    profile
      ? (typeof profile.transcriptionModel === 'string' && profile.transcriptionModel.trim()) ||
        (typeof profile.model === 'string' && profile.model.trim()) ||
        (typeof profile.activeModel === 'string' && profile.activeModel.trim()) ||
        ''
      : '';
  const effectiveModel = modelFromArgs || profileModel;
  if (effectiveModel) return effectiveModel;

  if (profile) {
    const presetId =
      typeof profile.editionPreset === 'string' ? profile.editionPreset
      : typeof profile.transcriptionPreset === 'string' ? profile.transcriptionPreset
      : null;
    if (presetId) {
      const preset = resolveTranscriptionPreset(presetId);
      if (preset.id !== 'standard') {
        return `${preset.name}版`;
      }
    }
  }
  return BASE_EDITION_LABEL;
}

const EDITION_ORDER: [{ edition: 'asc' }, { updatedAt: 'desc' }] = [{ edition: 'asc' }, { updatedAt: 'desc' }];

export async function resolveRepository(
  owner: string,
  repo: string,
  versionOrBranch?: string,
  edition?: string,
  includeClause?: any
): Promise<ResolvedRepositoryResult | null> {
  if (!owner || !repo) return null;

  if (owner === 'personal' || owner === 'default') {
    const legacyRepo = await prisma.repository.findFirst({
      where: { repo, edition: edition ?? '' },
      orderBy: EDITION_ORDER,
      include: includeClause && typeof includeClause === 'object' ? includeClause : undefined
    });
    if (legacyRepo) {
      return {
        repository: legacyRepo,
        resolvedBranch: legacyRepo.branch,
        targetVersionLabel: legacyRepo.semVerLabel || undefined,
        isFallback: true,
        resolvedEdition: legacyRepo.edition ?? ''
      };
    }
  }

  const defaultBranch = ENGINE_CONFIG.defaultBranch;
  const hasInclude = includeClause && typeof includeClause === 'object';
  const wantedEdition = edition ?? '';

  // Match owner/repo case-insensitively so mixed-case repository URLs resolve cleanly.
  const ownerWhere = { equals: owner.trim(), mode: 'insensitive' as const };
  const repoWhere = { equals: repo.trim(), mode: 'insensitive' as const };

  if (versionOrBranch && versionOrBranch !== 'latest' && versionOrBranch !== 'default') {
    const cleanVer = versionOrBranch.trim();

    const exactBranchRepo = await prisma.repository.findFirst({
      where: { owner: ownerWhere, repo: repoWhere, branch: cleanVer, edition: wantedEdition },
      orderBy: EDITION_ORDER,
      include: hasInclude ? includeClause : undefined
    });

    if (exactBranchRepo) {
      return {
        repository: exactBranchRepo,
        resolvedBranch: exactBranchRepo.branch,
        targetVersionLabel: exactBranchRepo.semVerLabel || undefined,
        isFallback: false,
        resolvedEdition: exactBranchRepo.edition ?? ''
      };
    }

    const exactSemVerRepo = await prisma.repository.findFirst({
      where: { owner: ownerWhere, repo: repoWhere, semVerLabel: cleanVer, edition: wantedEdition },
      orderBy: EDITION_ORDER,
      include: hasInclude ? includeClause : undefined
    });

    if (exactSemVerRepo) {
      return {
        repository: exactSemVerRepo,
        resolvedBranch: exactSemVerRepo.branch,
        targetVersionLabel: exactSemVerRepo.semVerLabel || cleanVer,
        isFallback: false,
        resolvedEdition: exactSemVerRepo.edition ?? ''
      };
    }

    const partialRepo = await prisma.repository.findFirst({
      where: {
        owner: ownerWhere,
        repo: repoWhere,
        edition: wantedEdition,
        semVerLabel: {
          contains: cleanVer,
          mode: 'insensitive'
        }
      },
      orderBy: EDITION_ORDER,
      include: hasInclude ? includeClause : undefined
    });

    if (partialRepo) {
      return {
        repository: partialRepo,
        resolvedBranch: partialRepo.branch,
        targetVersionLabel: partialRepo.semVerLabel || cleanVer,
        isFallback: false,
        resolvedEdition: partialRepo.edition ?? ''
      };
    }

    const primaryRepo = await prisma.repository.findFirst({
      where: { owner: ownerWhere, repo: repoWhere, branch: defaultBranch, edition: wantedEdition },
      orderBy: EDITION_ORDER,
      include: hasInclude ? includeClause : undefined
    }) || await prisma.repository.findFirst({
      where: { owner: ownerWhere, repo: repoWhere, edition: wantedEdition },
      orderBy: EDITION_ORDER,
      include: hasInclude ? includeClause : undefined
    });

    if (primaryRepo) {
      return {
        repository: primaryRepo,
        resolvedBranch: primaryRepo.branch,
        targetVersionLabel: cleanVer,
        isFallback: true,
        resolvedEdition: primaryRepo.edition ?? ''
      };
    }

    if (wantedEdition !== '') {
      const fallback = await resolveRepository(owner, repo, versionOrBranch, '', includeClause);
      if (fallback) {
        return {
          ...fallback,
          isFallback: true,
          editionMiss: { requested: wantedEdition },
        };
      }
      return null;
    }
    return null;
  }

  const defaultRepo = await prisma.repository.findFirst({
    where: { owner: ownerWhere, repo: repoWhere, branch: defaultBranch, edition: wantedEdition },
    orderBy: EDITION_ORDER,
    include: hasInclude ? includeClause : undefined
  }) || await prisma.repository.findFirst({
    where: { owner: ownerWhere, repo: repoWhere, edition: wantedEdition },
    orderBy: EDITION_ORDER,
    include: hasInclude ? includeClause : undefined
  });

  if (!defaultRepo && wantedEdition !== '') {
    const fallback = await resolveRepository(owner, repo, versionOrBranch, '', includeClause);
    if (fallback) {
      return {
        ...fallback,
        isFallback: true,
        editionMiss: { requested: wantedEdition },
      };
    }
    return null;
  }
  if (!defaultRepo && wantedEdition === '') {
    const fallbackAnyEdition = await prisma.repository.findFirst({
      where: { owner: ownerWhere, repo: repoWhere },
      orderBy: [{ updatedAt: 'desc' }],
      include: hasInclude ? includeClause : undefined
    });
    if (fallbackAnyEdition) {
      return {
        repository: fallbackAnyEdition,
        resolvedBranch: fallbackAnyEdition.branch,
        targetVersionLabel: fallbackAnyEdition.semVerLabel || undefined,
        isFallback: true,
        resolvedEdition: fallbackAnyEdition.edition ?? ''
      };
    }
  }
  if (!defaultRepo) return null;

  return {
    repository: defaultRepo,
    resolvedBranch: defaultRepo.branch,
    targetVersionLabel: defaultRepo.semVerLabel || undefined,
    isFallback: false,
    resolvedEdition: defaultRepo.edition ?? ''
  };
}

export async function getRepositoryVersions(owner: string, repo: string): Promise<RepositoryVersionOption[]> {
  if (!owner || !repo) return [];

  // Match owner/repo case-insensitively so mixed-case repository URLs resolve cleanly.
  const ownerWhere = { equals: owner.trim(), mode: 'insensitive' as const };
  const repoWhere = { equals: repo.trim(), mode: 'insensitive' as const };

  const repos = await prisma.repository.findMany({
    where: { owner: ownerWhere, repo: repoWhere },
    select: { branch: true, semVerLabel: true }
  });

  const chunkVersions = await prisma.documentChunk.findMany({
    where: {
      document: {
        repository: {
          owner: ownerWhere,
          repo: repoWhere
        },
        ownerUserId: null
      },
      semVerLabel: { not: null }
    },
    distinct: ['semVerLabel'],
    select: { semVerLabel: true }
  }).catch((err) => {
    console.warn('[repository-resolver] version options query failed:', err);
    return [];
  });

  const optionsMap = new Map<string, RepositoryVersionOption>();

  for (const r of repos) {
    const key = r.semVerLabel || r.branch;
    const label = r.semVerLabel ? `${r.semVerLabel} (${r.branch})` : r.branch;
    optionsMap.set(key, {
      branch: r.branch,
      semVerLabel: r.semVerLabel,
      isDefault: r.branch === ENGINE_CONFIG.defaultBranch,
      label
    });
  }

  for (const cv of chunkVersions) {
    if (cv.semVerLabel && !optionsMap.has(cv.semVerLabel)) {
      optionsMap.set(cv.semVerLabel, {
        branch: ENGINE_CONFIG.defaultBranch,
        semVerLabel: cv.semVerLabel,
        isDefault: false,
        label: cv.semVerLabel
      });
    }
  }

  const result = Array.from(optionsMap.values());
  result.sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return b.label.localeCompare(a.label);
  });

  return result;
}

async function resolveRepositoryAnyEditionImpl(
  owner: string,
  repo: string,
  includeClause?: any
): Promise<ResolvedRepositoryResult | null> {
  if (!owner || !repo) return null;
  const row = await prisma.repository.findFirst({
    where: {
      owner: { equals: owner.trim(), mode: 'insensitive' },
      repo: { equals: repo.trim(), mode: 'insensitive' },
    },
    orderBy: EDITION_ORDER,
    include: includeClause && typeof includeClause === 'object' ? includeClause : undefined
  });
  if (!row) return null;
  return {
    repository: row,
    resolvedBranch: row.branch,
    targetVersionLabel: row.semVerLabel || undefined,
    isFallback: false,
    resolvedEdition: row.edition ?? ''
  };
}

export const resolveRepositoryAnyEdition = cache(resolveRepositoryAnyEditionImpl);

export async function findPublicGroupRow(owner: string, repo: string) {
  if (!owner || !repo) return null;
  return prisma.repository.findFirst({
    where: {
      owner: { equals: owner.trim(), mode: 'insensitive' },
      repo: { equals: repo.trim(), mode: 'insensitive' },
      isPublic: true,
      documents: { some: {} },
    },
    orderBy: EDITION_ORDER,
  });
}

export async function isRepositoryGroupPublic(owner: string, repo: string): Promise<boolean> {
  if (!owner || !repo) return false;
  const row = await prisma.repository.findFirst({
    where: {
      owner: { equals: owner.trim(), mode: 'insensitive' },
      repo: { equals: repo.trim(), mode: 'insensitive' },
      isPublic: true,
    },
    select: { id: true },
  });
  return !!row;
}

export async function getRepositoryEditions(
  owner: string,
  repo: string,
  opts?: { userId?: string | null; branch?: string }
): Promise<RepositoryEditionOption[]> {
  if (!owner || !repo) return [];
  const rows = await prisma.repository.findMany({
    where: {
      owner: { equals: owner.trim(), mode: 'insensitive' },
      repo: { equals: repo.trim(), mode: 'insensitive' },
      ...(opts?.branch ? { branch: opts.branch } : {}),
      OR: [
        { isPublic: true },
        ...(opts?.userId
          ? [
              { savedRepos: { some: { userId: opts.userId } } },
              { importRecords: { some: { userId: opts.userId } } },
            ]
          : []),
      ],
    },
    select: {
      id: true,
      branch: true,
      edition: true,
      repoProfile: true,
      isPublic: true,
      transcriptionModels: true,
      relayEnabled: true,
      updatedAt: true,
      createdAt: true,
      reviewPipeline: true,
      reviewLlm: true,
      importRecords: {
        select: {
          userId: true,
          user: {
            select: { id: true, name: true, image: true },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: 1,
      },
    },
    orderBy: EDITION_ORDER,
  }).catch((err) => {
    console.warn('[repository-resolver] edition rows query failed:', err);
    return [];
  });

  const repoIds = rows.map((r) => r.id);
  const docFilter = docVisibilityFilter(opts?.userId);
  // Aggregate status/model counts in SQL and read profile.totalWords to avoid loading MDX bodies.
  const [statusGroups, modelGroups] = repoIds.length
    ? await Promise.all([
        prisma.document
          .groupBy({
            by: ['repositoryId', 'status'],
            _count: { _all: true },
            where: { repositoryId: { in: repoIds }, ...docFilter },
          })
          .catch((err) => {
            console.warn('[repository-resolver] status groupBy failed:', err);
            return [];
          }),
        prisma.document
          .groupBy({
            by: ['repositoryId', 'generationModel'],
            where: {
              repositoryId: { in: repoIds },
              generationModel: { not: null },
              ...docFilter,
            },
          })
          .catch((err) => {
            console.warn('[repository-resolver] model groupBy failed:', err);
            return [];
          }),
      ] as const)
    : ([[], []] as const);

  const docCountByRepo = new Map<string, { total: number; processed: number }>();
  for (const g of statusGroups) {
    const entry = docCountByRepo.get(g.repositoryId) ?? { total: 0, processed: 0 };
    entry.total += g._count._all;
    if (g.status === 'PROCESSED') entry.processed += g._count._all;
    docCountByRepo.set(g.repositoryId, entry);
  }
  const docModelsByRepo = new Map<string, string[]>();
  for (const g of modelGroups) {
    const model = typeof g.generationModel === 'string' ? g.generationModel.trim() : '';
    if (!model) continue;
    const list = docModelsByRepo.get(g.repositoryId) ?? [];
    list.push(model);
    docModelsByRepo.set(g.repositoryId, list);
  }

  return rows.map((r) => {
    const profile = (r.repoProfile ?? {}) as Record<string, unknown>;
    const presetId =
      typeof profile.editionPreset === 'string' ? profile.editionPreset : null;
    const counts = docCountByRepo.get(r.id) ?? { total: 0, processed: 0 };
    const totalDocs = counts.total;
    const processedDocs = counts.processed;

    const firstImportRecord = (r as any).importRecords?.[0];
    const firstImportUser = firstImportRecord?.user;
    const rawImportUserName =
      typeof firstImportUser?.name === 'string' && firstImportUser.name.trim().length > 0
        ? firstImportUser.name.trim()
        : null;
    const profileCreator =
      typeof profile.creator === 'string' && profile.creator.trim().length > 0
        ? profile.creator.trim()
        : typeof profile.creatorName === 'string' && profile.creatorName.trim().length > 0
        ? profile.creatorName.trim()
        : null;
    const creatorName = rawImportUserName || profileCreator || null;

    const firstImportUserId = firstImportRecord?.userId || firstImportUser?.id;
    const isCurrentUserCreator = Boolean(
      opts?.userId &&
        ((firstImportUserId && firstImportUserId === opts.userId) ||
          (typeof profile.creatorId === 'string' && profile.creatorId === opts.userId))
    );

    let wordCount: number | undefined;
    if (
      typeof profile.totalWords === 'number' &&
      Number.isFinite(profile.totalWords) &&
      profile.totalWords >= 0
    ) {
      wordCount = profile.totalWords;
    }

    const preset = presetId ? resolveTranscriptionPreset(presetId) : null;
    const rawTeachingDepth =
      typeof profile.teachingDepth === 'string' && profile.teachingDepth.trim().length > 0
        ? profile.teachingDepth.trim()
        : null;
    const teachingDepth = rawTeachingDepth || preset?.defaults?.teachingDepth || undefined;

    const rawModels = (r.transcriptionModels || []).filter(Boolean);
    const docModels = Array.from(new Set(docModelsByRepo.get(r.id) ?? []));
    const profileModel =
      typeof profile.transcriptionModel === 'string' && profile.transcriptionModel.trim()
        ? profile.transcriptionModel.trim()
        : typeof profile.model === 'string' && profile.model.trim()
        ? profile.model.trim()
        : typeof profile.activeModel === 'string' && profile.activeModel.trim()
        ? profile.activeModel.trim()
        : null;

    const effectiveModels =
      rawModels.length > 0
        ? rawModels
        : docModels.length > 0
        ? docModels
        : profileModel
        ? [profileModel]
        : [];

    const isFullyTranscribed = totalDocs > 0 && processedDocs >= totalDocs;

    return {
      id: r.id,
      edition: r.edition ?? '',
      label: deriveEditionLabel(r.repoProfile, effectiveModels),
      presetId,
      isDefault: (r.edition ?? '') === '',
      branch: r.branch,
      isPublic: r.isPublic,
      transcriptionModels: effectiveModels,
      createdAt: r.createdAt ? r.createdAt.toISOString() : undefined,
      updatedAt: r.updatedAt ? r.updatedAt.toISOString() : undefined,
      chapterCount: totalDocs,
      processedDocsCount: processedDocs,
      creatorName,
      isCurrentUserCreator,
      wordCount,
      teachingDepth,
      relayEnabled: Boolean(r.relayEnabled),
      isFullyTranscribed,
      reviewPipeline: r.reviewPipeline ?? null,
      reviewLlm: r.reviewLlm ?? null,
      reviewAppealsRemaining: typeof profile.reviewAppealsRemaining === 'number' ? profile.reviewAppealsRemaining : 3,
      relay: (r.relayEnabled && totalDocs > 0 && processedDocs < totalDocs)
        ? { done: processedDocs, total: totalDocs, inProgress: 0, participants: [] }
        : null,
    };
  });
}
