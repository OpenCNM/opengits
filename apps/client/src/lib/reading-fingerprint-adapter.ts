import { ignoreBestEffort } from '@/lib/best-effort';
import { prisma } from '@/lib/db';
import { computeReadingFingerprintBatchViaSidecar } from '@/engine/fingerprint-driver';
import { TtlCache } from '@/lib/cache/ttl-cache';
import type { ChapterMeta, RawTelemetryEvent, ProgressResult } from '@/engine/reading-fingerprint/types';

const PROGRESS_BATCH_CACHE_TTL_MS = 45_000;
const PROGRESS_BATCH_CACHE_MAX_ENTRIES = 512;
const progressBatchCache = new TtlCache<Record<string, { progress: number; viewedCount: number; lastReadPath: string | null; lastReadAt: Date | string | null; chapterScores: Record<string, number> }>>(
  PROGRESS_BATCH_CACHE_TTL_MS,
  PROGRESS_BATCH_CACHE_MAX_ENTRIES
);

type ProgressBatchRepos = Parameters<typeof computeProgressBatch>[1];

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

export async function computeProgressBatchCached(userId: string, repos: ProgressBatchRepos) {
  if (!repos || repos.length === 0 || !userId) {
    return computeProgressBatch(userId, repos);
  }
  return progressBatchCache.getOrLoad(progressBatchCacheKey(userId, repos), () =>
    computeProgressBatch(userId, repos)
  );
}

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

  if (!repos || repos.length === 0) {
    return result;
  }

  if (!userId) {
    repos.forEach(r => { result[r.id] = { progress: 0, viewedCount: 0, lastReadPath: null, lastReadAt: null, chapterScores: {} }; });
    return result;
  }

  const urlPrefixes = repos.flatMap(r => [
    `/docs/${r.owner}/${r.repo}`.toLowerCase(),
    `/docs/personal/${r.owner}/${r.repo}`.toLowerCase(),
  ]);

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
    ignoreBestEffort();
  }

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

  const batchItems = repos.map(repo => {
    const prefix = `/docs/${repo.owner}/${repo.repo}`.toLowerCase();
    const chapters: ChapterMeta[] = repo.docs.map(doc => ({
      path: doc.path,
      wordCount: 500,
      codeBlockCount: 2,
      headingCount: 3,
      pageUrl: buildPageUrl(repo.owner, repo.repo, doc.path),
    }));

    const repoCreatedAt = repo.createdAt ? new Date(repo.createdAt) : null;
    const isCustomEdition = Boolean(repo.edition && repo.edition !== '');

    const repoEvents = rawEvents.filter(e => {
      const cleanUrl = e.pageUrl.replace(/\/$/, '').toLowerCase();
      const urlMatches = cleanUrl === prefix || cleanUrl.startsWith(`${prefix}/`);
      if (!urlMatches) return false;
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
