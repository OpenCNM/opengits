import { prisma } from '@/lib/db';
import { computeReadingFingerprintBatchViaSidecar } from '@/engine/fingerprint-driver';
import { TtlCache } from '@/lib/cache/ttl-cache';
import type { ChapterMeta, RawTelemetryEvent, ProgressResult } from '@/engine/reading-fingerprint/types';

// ── 读侧 TTL 结果缓存（性能修复 2026-10-13）──
// docs 布局每次渲染为登录用户拉最多 10,000 条 EpisodicEvent（含 metadata Json），
// 首页亦全量批算。计算体一字不动（浮点 golden 契约保护）——仅读侧包装缓存；
// 侧栏阅读徽章最多滞后一个 TTL 窗口（徽章本就按导航节奏刷新，可接受）。
const PROGRESS_BATCH_CACHE_TTL_MS = 45_000;
const PROGRESS_BATCH_CACHE_MAX_ENTRIES = 512;
const progressBatchCache = new TtlCache<Record<string, { progress: number; viewedCount: number; lastReadPath: string | null; lastReadAt: Date | string | null; chapterScores: Record<string, number> }>>(
  PROGRESS_BATCH_CACHE_TTL_MS,
  PROGRESS_BATCH_CACHE_MAX_ENTRIES
);

type ProgressBatchRepos = Parameters<typeof computeProgressBatch>[1];

/** 影响结果的全部入参字段（id/owner/repo/edition/createdAt/docs paths）的确定性指纹（FNV-1a 32-bit） */
function progressBatchCacheKey(userId: string, repos: ProgressBatchRepos): string {
  const payload = JSON.stringify([
    userId,
    repos.map((r) => [r.id, r.owner, r.repo, r.edition ?? null, r.createdAt ?? null, r.docs.map((d) => d.path)]),
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${userId}:${h.toString(16)}`;
}

/** 带缓存的批量阅读进度计算（TtlCache 单飞防击穿；原始 computeProgressBatch 保持纯净便于测试） */
export async function computeProgressBatchCached(userId: string, repos: ProgressBatchRepos) {
  if (!repos || repos.length === 0 || !userId) {
    return computeProgressBatch(userId, repos);
  }
  return progressBatchCache.getOrLoad(progressBatchCacheKey(userId, repos), () =>
    computeProgressBatch(userId, repos)
  );
}

// URL construction helper - matches actual App Router URL path (/docs/owner/repo/slug)
function buildPageUrl(owner: string, repo: string, docPath: string): string {
  let slug = docPath.replace(/\.mdx?$/, '');
  const lower = slug.toLowerCase();
  if (lower === 'readme' || lower === 'index') {
    slug = '';
  } else if (lower.endsWith('/readme')) {
    slug = slug.substring(0, slug.length - 7);
  } else if (lower.endsWith('/index')) {
    slug = slug.substring(0, slug.length - 6);
  }
  return `/docs/${owner}/${repo}${slug ? '/' + slug : ''}`.toLowerCase();
}

/**
 * Batch-compute reading fingerprint progress for multiple repositories.
 * Does a single bulk query of EpisodicEvents then distributes to per-repo engine calls.
 *
 * @returns Map from repositoryId to { progress, viewedCount }
 */
export async function computeProgressBatch(
  userId: string,
  repos: Array<{
    id: string;
    owner: string;
    repo: string;
    edition?: string;
    createdAt?: Date | string;
    docs: Array<{ path: string; status?: string }>;
  }>
): Promise<Record<string, { progress: number; viewedCount: number; lastReadPath: string | null; lastReadAt: Date | string | null; chapterScores: Record<string, number> }>> {
  const result: Record<string, { progress: number; viewedCount: number; lastReadPath: string | null; lastReadAt: Date | string | null; chapterScores: Record<string, number> }> = {};

  // 0. 前置彻底短路：若无仓库直接返回空对象，跳过无谓的 10,000 条事件 SQL 查询
  if (!repos || repos.length === 0) {
    return result;
  }

  if (!userId) {
    repos.forEach(r => { result[r.id] = { progress: 0, viewedCount: 0, lastReadPath: null, lastReadAt: null, chapterScores: {} }; });
    return result;
  }

  // 1. Build URL prefix set for filtering events (/docs/owner/repo)
  const urlPrefixes = repos.flatMap(r => [
    `/docs/${r.owner}/${r.repo}`.toLowerCase(),
    `/docs/personal/${r.owner}/${r.repo}`.toLowerCase(), // fallback for legacy events
  ]);

  // 2. Bulk query telemetry events for this user (bounded to last 90 days + capped at 10k events)
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const events = await prisma.episodicEvent.findMany({
    where: {
      userId,
      createdAt: { gte: ninetyDaysAgo },
      OR: [
        ...urlPrefixes.map(prefix => ({ pageUrl: { startsWith: prefix } })),
        ...urlPrefixes.map(prefix => ({ targetId: { startsWith: prefix } })),
      ],
    },
    select: {
      eventType: true,
      pageUrl: true,
      targetId: true,
      duration: true,
      createdAt: true,
      metadata: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 10_000,
  });

  // 3. Query reading progress for lastReadPath and updatedAt
  const repoIds = repos.map(r => r.id);
  const readingProgressMap: Record<string, { lastReadPath: string | null; lastReadAt: Date | null }> = {};
  try {
    const progressList = await prisma.userReadingProgress.findMany({
      where: { userId, repositoryId: { in: repoIds } },
      select: { repositoryId: true, lastReadPath: true, updatedAt: true },
    });
    progressList.forEach(p => {
      readingProgressMap[p.repositoryId] = {
        lastReadPath: p.lastReadPath,
        lastReadAt: p.updatedAt,
      };
    });
  } catch {
    // Table may not exist yet
  }

  // 4. Map events to RawTelemetryEvent format and normalize pageUrl (strip /personal/ if present; fallback to targetId if pageUrl was corrupted)
  const rawEvents: RawTelemetryEvent[] = events.map(e => {
    const rawTarget = typeof e.targetId === 'string' ? e.targetId : '';
    const rawPage = typeof e.pageUrl === 'string' ? e.pageUrl : '';
    const effectiveUrl = (rawPage && rawPage.startsWith('/docs/'))
      ? rawPage
      : (rawTarget && rawTarget.startsWith('/docs/'))
      ? rawTarget
      : rawPage;

    return {
      eventType: e.eventType,
      pageUrl: effectiveUrl.replace(/^\/docs\/personal\//i, '/docs/'),
      targetId: e.targetId,
      duration: e.duration,
      createdAt: e.createdAt,
      metadata: e.metadata as Record<string, unknown> | null,
    };
  });

  // 5. 为所有仓库组装批处理项，单次 RPC 往返完成全量计算（消解 N 次串行网络风暴）
  const batchItems = repos.map(repo => {
    const prefix = `/docs/${repo.owner}/${repo.repo}`.toLowerCase();
    const chapters: ChapterMeta[] = repo.docs.map(doc => ({
      path: doc.path,
      wordCount: 500,         // v1 default estimate
      codeBlockCount: 2,      // v1 default estimate
      headingCount: 3,        // v1 default estimate
      pageUrl: buildPageUrl(repo.owner, repo.repo, doc.path),
    }));

    const repoCreatedAt = repo.createdAt ? new Date(repo.createdAt) : null;
    const isCustomEdition = Boolean(repo.edition && repo.edition !== '');

    const repoEvents = rawEvents.filter(e => {
      const cleanUrl = e.pageUrl.replace(/\/$/, '').toLowerCase();
      const urlMatches = cleanUrl === prefix || cleanUrl.startsWith(`${prefix}/`);
      if (!urlMatches) return false;
      // 衍生讲法防串读：讲法创建时间之前的历史阅读事件不属于新建立的讲法
      if (isCustomEdition && repoCreatedAt && new Date(e.createdAt) < repoCreatedAt) {
        return false;
      }
      return true;
    });

    return {
      repoId: repo.id,
      chapters,
      events: repoEvents,
    };
  });

  let batchResults: Record<string, ProgressResult> = {};
  try {
    batchResults = await computeReadingFingerprintBatchViaSidecar(batchItems);
  } catch (err) {
    console.warn('[ReadingFingerprint] Sidecar batch compute failed, falling back to zero progress', err);
  }

  // 6. 聚合每个仓库的进度结果（含最后阅读记录）
  const batchItemMap = new Map(batchItems.map(b => [b.repoId, b]));

  for (const repo of repos) {
    const item = batchItemMap.get(repo.id);
    const chapters = item?.chapters ?? [];
    const fingerprint = batchResults[repo.id] ?? {
      overallProgress: 0,
      totalChapters: chapters.length,
      effectivelyRead: 0,
      chapterScores: [],
    };

    const chapterScoresMap: Record<string, number> = {};
    fingerprint.chapterScores.forEach(cs => {
      chapterScoresMap[cs.path] = cs.score;
    });

    const overallProgress = fingerprint.overallProgress;

    const repoProgressInfo = readingProgressMap[repo.id];
    result[repo.id] = {
      progress: overallProgress,
      viewedCount: fingerprint.effectivelyRead,
      lastReadPath: repoProgressInfo?.lastReadPath ?? null,
      lastReadAt: repoProgressInfo?.lastReadAt ?? null,
      chapterScores: chapterScoresMap,
    };
  }

  return result;
}
