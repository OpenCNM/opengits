import { prisma } from '@/lib/db';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import {
  resolveRepository,
  resolveRepositoryAnyEdition,
  getRepositoryEditions,
  resolveRepositoryDisplayName,
  findPublicGroupRow,
  type RepositoryEditionOption,
} from '@/lib/repository-resolver';
import { getActiveOutline, allChaptersInTeachingOrder, type OutlineView } from '@/lib/outline-reader';
import { resolveEffectiveNavTree } from '@/lib/mcp/outline-projector';
import { computeProgressBatchCached } from '@/lib/reading-fingerprint-adapter';
import type { NavNode } from './docs-nav-tree';
import {
  getWebL1OutlineProjection,
  DEFAULT_L1_TTL_MS,
  type WebL1OutlineProjection,
} from './web-outline-projection';

export interface RelayParticipant {
  userId: string;
  name: string | null;
  image: string | null;
  active: boolean;
}

export interface DocsLoginGateData {
  owner: string;
  repo: string;
  title: string;
  chapterCount: number;
  bakedCount: number;
  relayInProgress: number;
  relayParticipants: RelayParticipant[];
}

export interface DocsEditionProjection {
  edition: string;
  outline: OutlineView | null;
  navTree: NavNode[];
  repoProfile: unknown;
  branch: string | null;
}

export type DocsLayoutResult =
  | { status: 'login-gate'; loginGateData: DocsLoginGateData }
  | { status: 'forbidden' }
  | { status: 'not-found' }
  | { status: 'sync-prompt'; canSync: boolean }
  | {
      status: 'ready';
      repository: WebL1OutlineProjection['repoSnapshot'] | { id: string; owner: string; repo: string; branch: string; isPublic: boolean; repoProfile?: unknown; [key: string]: unknown };
      repositoryId: string;
      isAuthorized: boolean;
      isMaintainer: boolean;
      relayEnabled: boolean;
      repoProfile: unknown;
      repoIsPublic: boolean;
      helpfulInfo: { count: number; voted: boolean } | null;
      transcriptionModels: string[];
      transcriptionTokens: number;
      editionOptions: RepositoryEditionOption[];
      resolvedBranch: string | null;
      outline: OutlineView | null;
      navTree: NavNode[];
      chapterScores: Record<string, number>;
      hotPaths: Set<string>;
      resumeAdvice?: { edition: string; label: string; lastReadPath: string } | null;
      editionProjections?: Record<string, DocsEditionProjection>;
    };

export async function fetchWebL1OutlineProjection(
  owner: string,
  repo: string,
  edition?: string
): Promise<WebL1OutlineProjection | null> {
  const resolved = edition
    ? await resolveRepository(owner, repo, undefined, edition)
    : await resolveRepositoryAnyEdition(owner, repo);
  const repository = resolved?.repository;
  if (!repository) return null;

  const repositoryId = repository.id;
  const resolvedBranch = resolved?.resolvedBranch ?? repository.branch ?? null;

  let outline: OutlineView | null = null;
  try {
    outline = await getActiveOutline(repositoryId);
  } catch (err) {
    console.warn(`[DocsLayoutLoader] Failed to read active outline for ${owner}/${repo}:`, err);
  }

  const navTree = (await resolveEffectiveNavTree(repositoryId, {
    owner,
    repo,
    outline,
    fallbackNavTree: repository.navTree,
  })) as unknown as NavNode[];

  let editionOptions: RepositoryEditionOption[] = [];
  try {
    editionOptions = await getRepositoryEditions(owner, repo);
  } catch (err) {
    console.warn(`[DocsLayoutLoader] Failed to read editions for ${owner}/${repo}:`, err);
  }

  const docPaths: string[] = [];
  const teachingDocPaths: string[] = [];
  if (outline) {
    const chapters = [...outline.chapters, ...outline.parts.flatMap((p) => p.chapters)];
    for (const ch of chapters) {
      for (const n of ch.nodes) {
        if (n.docPath) {
          docPaths.push(n.docPath);
          teachingDocPaths.push(n.docPath);
        }
      }
    }
  } else {
    const walk = (nodes: NavNode[]) => {
      for (const n of nodes) {
        if (n.type === 'file' && n.path) docPaths.push(n.path);
        if (n.children) walk(n.children);
      }
    };
    walk(navTree);
  }

  return {
    repositoryId,
    owner,
    repo,
    branch: resolvedBranch || repository.branch || '',
    edition: repository.edition || edition || '',
    gitSha: repository.gitSha ?? null,
    outlineVersion: outline?.version ?? 1,
    outline: outline ?? { outlineId: '', version: 1, mode: 'tutorial', parts: [], chapters: [] },
    navTree,
    docPaths,
    teachingDocPaths,
    editionOptions,
    repoSnapshot: {
      id: repository.id,
      owner: repository.owner,
      repo: repository.repo,
      branch: repository.branch,
      edition: repository.edition || '',
      isPublic: repository.isPublic,
      relayEnabled: Boolean(repository.relayEnabled),
      repoProfile: repository.repoProfile,
      transcriptionModels: repository.transcriptionModels || [],
      transcriptionTokens: repository.transcriptionTokens || 0,
      helpfulCount: repository.helpfulCount || 0,
      navTree: repository.navTree,
    },
    builtAt: Date.now(),
    expiresAt: Date.now() + DEFAULT_L1_TTL_MS,
  };
}

export async function loadDocsLayoutData(
  owner: string,
  repo: string,
  userId?: string,
  edition?: string
): Promise<DocsLayoutResult> {
  const projection = await getWebL1OutlineProjection(owner, repo, edition, () =>
    fetchWebL1OutlineProjection(owner, repo, edition)
  );

  if (!projection) {
    return { status: 'not-found' };
  }

  let repository = projection.repoSnapshot;
  let repositoryId = projection.repositoryId;
  const outline = projection.outline && projection.outline.outlineId ? projection.outline : null;
  const navTree = projection.navTree;
  const docPaths = projection.docPaths;
  let editionOptions = projection.editionOptions;
  let resolvedBranch: string | null = projection.branch || null;
  const repoProfile = repository.repoProfile;
  const repoIsPublic = repository.isPublic;
  const transcriptionModels = repository.transcriptionModels || [];
  const transcriptionTokens = repository.transcriptionTokens || 0;
  let isAuthorized = false;

  if (repoIsPublic) {
    isAuthorized = true;
  } else {
    isAuthorized = await verifyRepoAccessDirect(repository, userId);
    // Only fall back to a public sibling edition when no explicit ?edition= was requested.
    if (!isAuthorized && !edition) {
      const publicRow = await findPublicGroupRow(owner, repo).catch(() => null);
      if (publicRow && publicRow.id !== repository.id) {
        repository = publicRow;
        repositoryId = publicRow.id;
        resolvedBranch = publicRow.branch;
        isAuthorized = true;
      }
    }
  }

  if (userId) {
    try {
      const userEditions = await getRepositoryEditions(owner, repo, {
        userId,
      });
      if (userEditions.length > 0) {
        editionOptions = userEditions;
      }
    } catch (err) {
      console.warn(`[DocsLayoutLoader] Failed to read user editions for ${owner}/${repo}:`, err);
    }
  }

  let helpfulInfo: { count: number; voted: boolean } | null = null;
  if (userId && repoIsPublic) {
    const [count, vote] = await Promise.all([
      prisma.repository.findUnique({ where: { id: repository.id }, select: { helpfulCount: true } }),
      prisma.helpfulVote.findUnique({
        where: { repositoryId_userId: { repositoryId: repository.id, userId } },
        select: { id: true },
      }),
    ]);
    helpfulInfo = { count: count?.helpfulCount ?? (repository.helpfulCount || 0), voted: !!vote };
  }

  if (!userId && repositoryId && !repoIsPublic) {
    let chapterCount = 0;
    let bakedCount = 0;
    if (outline && outline.outlineId) {
      const allNodes = allChaptersInTeachingOrder(outline).flatMap((ch) => ch.nodes);
      chapterCount = allNodes.length;
      bakedCount = allNodes.filter((n) => n.docStatus === 'PROCESSED').length;
    } else {
      const [rawCount, rawBaked] = await Promise.all([
        prisma.document.count({ where: { repositoryId, ownerUserId: null } }),
        prisma.document.count({ where: { repositoryId, ownerUserId: null, status: 'PROCESSED' } }),
      ]);
      chapterCount = rawCount;
      bakedCount = rawBaked;
    }

    let relayInProgress = 0;
    let relayParticipants: RelayParticipant[] = [];
    const relayRepo = await prisma.repository.findUnique({
      where: { id: repositoryId },
      select: { relayEnabled: true },
    });

    if (relayRepo?.relayEnabled) {
      const relayJobs = await prisma.chapterUpdateJob.findMany({
        where: { repositoryId, status: { in: ['CLAIMED', 'TRIAL', 'SWAPPED'] } },
        select: { status: true, claimedBy: true },
      });
      const userIds = [...new Set(relayJobs.map((j) => j.claimedBy).filter((v): v is string => !!v))];
      const users = userIds.length
        ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, image: true } })
        : [];
      const userById = new Map(users.map((u) => [u.id, u]));
      const relaySummary = collectRelayParticipants(relayJobs, userById);
      relayInProgress = relaySummary.count;
      relayParticipants = relaySummary.participants;
    }

    return {
      status: 'login-gate',
      loginGateData: {
        owner,
        repo,
        title: resolveRepositoryDisplayName({ owner, repo, repoProfile }) || repo,
        chapterCount,
        bakedCount,
        relayInProgress,
        relayParticipants,
      },
    };
  }

  if (!isAuthorized) {
    return { status: 'forbidden' };
  }

  if (!repositoryId || ((!navTree || navTree.length === 0) && !outline)) {
    return {
      status: 'sync-prompt',
      canSync: Boolean(userId || process.env.NODE_ENV === 'development'),
    };
  }

  let chapterScores: Record<string, number> = {};
  const hotPaths = new Set<string>();
  if (userId && repositoryId && docPaths.length > 0) {
    try {
      const fpResult = await computeProgressBatchCached(userId, [
        {
          id: repositoryId,
          owner,
          repo,
          docs: docPaths.map((p) => ({ path: p })),
        },
      ]);
      chapterScores = fpResult[repositoryId]?.chapterScores || {};
    } catch (e) {
      console.warn('[DocsLayoutLoader] Failed to compute chapter scores:', e);
    }
  }

  let resumeAdvice: { edition: string; label: string; lastReadPath: string } | null = null;
  if (userId && editionOptions && editionOptions.length > 1) {
    resumeAdvice = await resolveResumeAdvice(userId, repositoryId, editionOptions);
  }

  const editionProjections: Record<string, DocsEditionProjection> = {
    [repository.edition || '']: {
      edition: repository.edition || '',
      outline,
      navTree,
      repoProfile,
      branch: resolvedBranch,
    },
  };

  if (editionOptions && editionOptions.length > 1) {
    await Promise.all(
      editionOptions.map(async (ed) => {
        if (ed.edition === (repository.edition || '')) return;
        try {
          const edProj = await getWebL1OutlineProjection(owner, repo, ed.edition, () =>
            fetchWebL1OutlineProjection(owner, repo, ed.edition)
          );
          if (edProj) {
            editionProjections[ed.edition] = {
              edition: ed.edition,
              outline: edProj.outline && edProj.outline.outlineId ? edProj.outline : null,
              navTree: edProj.navTree,
              repoProfile: edProj.repoSnapshot.repoProfile,
              branch: edProj.branch,
            };
          }
        } catch (e) {
          console.warn(`[DocsLayoutLoader] Failed to load edition projection for ${ed.edition}:`, e);
        }
      })
    );
  }

  let isMaintainer = false;
  if (userId) {
    const { resolveMaintainerUserId } = await import('@/lib/repository-maintainer');
    const maintainerUserId = await resolveMaintainerUserId(repository.id).catch(() => null);
    isMaintainer = maintainerUserId === userId;
  }
  const relayEnabled = Boolean((repository as any).relayEnabled);

  return {
    status: 'ready',
    repository,
    repositoryId,
    isAuthorized,
    isMaintainer,
    relayEnabled,
    repoProfile,
    repoIsPublic,
    helpfulInfo,
    transcriptionModels,
    transcriptionTokens,
    editionOptions,
    resolvedBranch,
    outline,
    navTree,
    chapterScores,
    hotPaths,
    resumeAdvice,
    editionProjections,
  };
}

function collectRelayParticipants(
  relayJobs: { status: string; claimedBy: string | null }[],
  userById: Map<string, { id: string; name: string | null; image: string | null }>
): { count: number; participants: RelayParticipant[] } {
  let inProgress = 0;
  const seen = new Map<string, RelayParticipant>();
  for (const job of relayJobs) {
    const user = job.claimedBy ? userById.get(job.claimedBy) : undefined;
    if (!user) continue;
    const isUnswapped = job.status !== 'SWAPPED';
    if (isUnswapped) inProgress++;

    const existing = seen.get(user.id);
    if (existing) {
      if (isUnswapped) existing.active = true;
    } else {
      seen.set(user.id, { userId: user.id, name: user.name, image: user.image, active: isUnswapped });
    }
  }
  return {
    count: inProgress,
    participants: [...seen.values()].sort((a, b) => Number(b.active) - Number(a.active)),
  };
}

async function resolveResumeAdvice(
  userId: string,
  repositoryId: string,
  editionOptions: { id: string; edition: string; label: string }[]
): Promise<{ edition: string; label: string; lastReadPath: string } | null> {
  const otherEditionIds = editionOptions.map((e) => e.id).filter((id) => id !== repositoryId);
  if (otherEditionIds.length === 0) return null;

  try {
    const recentOtherProgress = await prisma.userReadingProgress.findFirst({
      where: {
        userId,
        repositoryId: { in: otherEditionIds },
        lastReadPath: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
      select: { repositoryId: true, lastReadPath: true },
    });
    if (!recentOtherProgress?.lastReadPath) return null;

    const matchedOpt = editionOptions.find((e) => e.id === recentOtherProgress.repositoryId);
    if (!matchedOpt) return null;

    return {
      edition: matchedOpt.edition,
      label: matchedOpt.label,
      lastReadPath: recentOtherProgress.lastReadPath,
    };
  } catch (err) {
    console.warn('[DocsLayoutLoader] Failed to compute resumeAdvice:', err);
    return null;
  }
}

