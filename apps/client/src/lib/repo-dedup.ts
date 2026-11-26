import { prisma } from '@/lib/db';
import { resolveMaintainerUserId } from '@/lib/repository-maintainer';

export interface CanonicalRepo {
  owner: string;
  repo: string;
}

export interface DedupResult {
  existsOnShelf: boolean;
  existsInExplore: boolean;
  baseSlotOccupied?: boolean;
  existingRepo: {
    id: string;
    owner: string;
    repo: string;
    gitSha: string | null;
    transcriptionModels?: string[];
    isPublic: boolean;
    isMaintainer: boolean;
  } | null;
  isFork: boolean;
  upstream: { owner: string; repo: string } | null;
  upstreamExistsInExplore: boolean;
  upstreamRepo: { id: string; owner: string; repo: string; transcriptionModels?: string[] } | null;
}

export function canonicalizeRepo(owner: string, repo: string): CanonicalRepo {
  let cleanOwner = (owner || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  let cleanRepo = (repo || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');

  if (cleanRepo.endsWith('.git')) {
    cleanRepo = cleanRepo.slice(0, -4).replace(/\/+$/, '');
  }

  return { owner: cleanOwner, repo: cleanRepo };
}

export function isRepoTranscribing(repo: {
  documents?: Array<{ id?: string; status?: string | null }> | null;
}): boolean {
  if (repo.documents !== undefined) {
    if (!repo.documents || repo.documents.length === 0) {
      return true;
    }
    return repo.documents.some(
      (d) => d.status === 'UNPROCESSED' || d.status === 'PROCESSING' || d.status === 'ERROR'
    );
  }
  return false;
}

export function isRepoInReview(repo: {
  reviewStatus?: string | null;
}): boolean {
  return repo.reviewStatus === 'PENDING' || repo.reviewStatus === 'REJECTED';
}

export function isSearchablePublicTutorial(repo: {
  isPublic?: boolean | null;
  reviewStatus?: string | null;
  documents?: Array<{ id?: string; status?: string | null }> | null;
}): boolean {
  if (repo.isPublic === false) return false;
  if (isRepoInReview(repo)) return false;
  if (isRepoTranscribing(repo)) return false;
  if (repo.reviewStatus && repo.reviewStatus !== 'APPROVED') return false;
  return true;
}

export function isShelfExistingTutorial(repo: {
  isPublic?: boolean | null;
  reviewStatus?: string | null;
  documents?: Array<{ id?: string; status?: string | null }> | null;
}): boolean {
  if (isRepoInReview(repo)) return false;
  if (isRepoTranscribing(repo)) return false;
  if (repo.isPublic && repo.reviewStatus && repo.reviewStatus !== 'APPROVED') {
    return false;
  }
  return true;
}

export async function checkRepoDuplicates(params: {
  owner: string;
  repo: string;
  userId?: string | null;
  edition?: string;
  upstream?: { owner: string; repo: string } | null;
}): Promise<DedupResult> {
  const { owner, repo, userId, edition = '', upstream } = params;
  const canonical = canonicalizeRepo(owner, repo);

  const allMatchedRepos = await prisma.repository.findMany({
    where: {
      owner: { equals: canonical.owner, mode: 'insensitive' },
      repo: { equals: canonical.repo, mode: 'insensitive' },
      edition,
    },
    select: {
      id: true,
      owner: true,
      repo: true,
      isPublic: true,
      reviewStatus: true,
      gitSha: true,
      transcriptionModels: true,
      documents: { select: { id: true, status: true } },
    },
  });

  const existingPublicRepo = allMatchedRepos.find(isSearchablePublicTutorial) || null;
  const baseSlotOccupied = allMatchedRepos.some((r) => (r.documents?.length ?? 0) > 0);

  let existsOnShelf = false;
  let shelfRepoRecord: {
    id: string;
    owner: string;
    repo: string;
    isPublic: boolean;
    gitSha: string | null;
    transcriptionModels: string[];
  } | null = null;
  if (userId) {
    const userWithShelf = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        savedRepos: {
          where: { repository: { edition } },
          select: {
            repository: {
              select: {
                id: true,
                owner: true,
                repo: true,
                isPublic: true,
                reviewStatus: true,
                gitSha: true,
                transcriptionModels: true,
                documents: { select: { id: true, status: true } },
              },
            },
          },
        },
      },
    });

    if (userWithShelf?.savedRepos) {
      const match = userWithShelf.savedRepos.find(
        (sr) =>
          sr.repository.owner.toLowerCase() === canonical.owner &&
          sr.repository.repo.toLowerCase() === canonical.repo &&
          isShelfExistingTutorial(sr.repository)
      );
      if (match) {
        existsOnShelf = true;
        shelfRepoRecord = {
          ...match.repository,
          isPublic: Boolean(match.repository.isPublic),
          transcriptionModels: match.repository.transcriptionModels ?? [],
        };
      }
    }
  }

  let upstreamExistsInExplore = false;
  let upstreamRepoRecord: { id: string; owner: string; repo: string; transcriptionModels?: string[] } | null = null;
  let isFork = false;
  let canonicalUpstream: { owner: string; repo: string } | null = null;

  if (upstream?.owner && upstream?.repo) {
    isFork = true;
    canonicalUpstream = canonicalizeRepo(upstream.owner, upstream.repo);

    const matchedUpstream = await prisma.repository.findFirst({
      where: {
        owner: { equals: canonicalUpstream.owner, mode: 'insensitive' },
        repo: { equals: canonicalUpstream.repo, mode: 'insensitive' },
        isPublic: true,
        reviewStatus: 'APPROVED',
      },
      select: {
        id: true,
        owner: true,
        repo: true,
        isPublic: true,
        reviewStatus: true,
        transcriptionModels: true,
        documents: { select: { id: true, status: true } },
      },
    });

    if (matchedUpstream && isSearchablePublicTutorial(matchedUpstream)) {
      upstreamExistsInExplore = true;
      upstreamRepoRecord = {
        id: matchedUpstream.id,
        owner: matchedUpstream.owner,
        repo: matchedUpstream.repo,
        transcriptionModels: matchedUpstream.transcriptionModels ?? [],
      };
    }
  }

  const primaryExistingRepo = shelfRepoRecord || existingPublicRepo || null;

  let isMaintainer = false;
  if (userId && primaryExistingRepo) {
    const maintainerId = await resolveMaintainerUserId(primaryExistingRepo.id);
    isMaintainer = Boolean(maintainerId && maintainerId === userId);
  }

  return {
    existsOnShelf,
    existsInExplore: !!existingPublicRepo,
    baseSlotOccupied,
    existingRepo: primaryExistingRepo
      ? {
          id: primaryExistingRepo.id,
          owner: primaryExistingRepo.owner,
          repo: primaryExistingRepo.repo,
          gitSha: primaryExistingRepo.gitSha ?? null,
          transcriptionModels: primaryExistingRepo.transcriptionModels ?? [],
          isPublic: Boolean(primaryExistingRepo.isPublic || existingPublicRepo?.isPublic),
          isMaintainer,
        }
      : null,
    isFork,
    upstream: canonicalUpstream,
    upstreamExistsInExplore,
    upstreamRepo: upstreamRepoRecord,
  };
}
