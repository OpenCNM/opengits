import { prisma } from '@/lib/db';
import { resolveMaintainerUserId } from '@/lib/repository-maintainer';

export interface CanonicalRepo {
  owner: string;
  repo: string;
}

export interface DedupResult {
  /** 当前用户个人书架是否已有此仓库 */
  existsOnShelf: boolean;
  /** 探索广场是否已有此仓库的公开教程 */
  existsInExplore: boolean;
  /** 已存在的仓库记录（用于跳转或对比） */
  existingRepo: {
    id: string;
    owner: string;
    repo: string;
    gitSha: string | null;
    transcriptionModels?: string[];
    isPublic: boolean;
    isMaintainer: boolean;
  } | null;
  /** 是否为 Fork 仓库 */
  isFork: boolean;
  /** Fork 上游仓库信息 */
  upstream: { owner: string; repo: string } | null;
  /** 上游仓库是否已在探索广场 */
  upstreamExistsInExplore: boolean;
  /** 上游仓库记录（用于跳转） */
  upstreamRepo: { id: string; owner: string; repo: string; transcriptionModels?: string[] } | null;
}

/**
 * 将任意 owner / repo 提取并归一化为小写 Canonical 键
 */
export function canonicalizeRepo(owner: string, repo: string): CanonicalRepo {
  let cleanOwner = (owner || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  let cleanRepo = (repo || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');

  if (cleanRepo.endsWith('.git')) {
    cleanRepo = cleanRepo.slice(0, -4).replace(/\/+$/, '');
  }

  return { owner: cleanOwner, repo: cleanRepo };
}

/**
 * 检查仓库是否处于转录环节（未完成转录）：
 * 1. 无文档（刚创建尚未生成章节）
 * 2. 存在未完成的文档（status 为 UNPROCESSED 或 PROCESSING 或 ERROR）
 */
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

/**
 * 检查仓库是否处于审核状态（待审核 PENDING 或已驳回 REJECTED）：
 */
export function isRepoInReview(repo: {
  reviewStatus?: string | null;
}): boolean {
  return repo.reviewStatus === 'PENDING' || repo.reviewStatus === 'REJECTED';
}

/**
 * 判定一个仓库记录是否算作探索广场的「已有公开教程」（可被搜索到的公开成品教程）：
 * - 必须为公开教程 (isPublic === true)
 * - 绝不能处于审核状态 (reviewStatus 必须为 APPROVED，不可为 PENDING/REJECTED/NONE)
 * - 绝不能处于转录环节 (全量文档必须均为 PROCESSED，不可处于 UNPROCESSED/PROCESSING/ERROR)
 */
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

/**
 * 判定一个仓库记录是否算作个人书架的「已有教程」：
 * 核心契约（346 准则）：
 * 只要不能被搜索到，无论是转录状态还是审核状态，都不算已有教程。
 * 1. 绝不能处于转录状态：必须全量文档 PROCESSED，若还在转录环节则不算已有教程；
 * 2. 绝不能处于审核状态：不可为 PENDING 或 REJECTED；
 * 3. 若标记为公开，必须已经过审 (reviewStatus === 'APPROVED')。
 */
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

/**
 * 校验仓库的重复情况（书架重复、探索广场公开重复、Fork 上游重复）。
 *
 * 讲法维度：判重按「同 edition」口径——同一仓库的另一种讲法不算重复
 * （衍生导入/发布第二讲法是合法操作）；edition 缺省 '' 即基础讲法，
 * 与历史行为完全一致。
 */
export async function checkRepoDuplicates(params: {
  owner: string;
  repo: string;
  userId?: string | null;
  edition?: string;
  upstream?: { owner: string; repo: string } | null;
}): Promise<DedupResult> {
  const { owner, repo, userId, edition = '', upstream } = params;
  const canonical = canonicalizeRepo(owner, repo);

  // 1. 查询当前仓库在系统中的任意记录（不限是否公开）
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

  // 2. 查询当前用户的个人书架（同讲法口径：另一讲法在架上不算本讲法重复）
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

  // 3. 查询 Fork 上游仓库情况
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
