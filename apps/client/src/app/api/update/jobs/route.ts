import { prisma } from '@/lib/db';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { ENGINE_CONFIG } from '@/lib/config';
import { allChaptersInTeachingOrder, getActiveOutline } from '@/lib/outline-reader';

export const dynamic = 'force-dynamic';

interface RelayOutlineNodeItem {
  id: string;
  documentId: string;
  title: string;
  path: string;
  status: 'PROCESSED' | 'CLAIMED' | 'UNPROCESSED';
  versionCount: number;
  claimedBy: string | null;
  jobId: string | null;
}

interface RelayOutlineChapterItem {
  id: string;
  title: string;
  teachingOrder: number;
  nodes: RelayOutlineNodeItem[];
}

interface RelayWorkbenchResponse {
  repo: {
    owner: string;
    repo: string;
    title: string;
    description: string;
    totalDocs: number;
    processedDocs: number;
    progressPercent: number;
    qualityHold: boolean;
  };
  outline: RelayOutlineChapterItem[];
  jobs: unknown[];
}

function profileString(profile: unknown, keys: string[]): string {
  if (!profile || typeof profile !== 'object') return '';
  const record = profile as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

import { parseChapterTitle } from '@/lib/chapter-title';
import { formatProgressPercent } from '@/lib/format';

const TECH_ACRONYMS: Record<string, string> = {
  cli: 'CLI',
  faq: 'FAQ',
  api: 'API',
  ui: 'UI',
  cpp: 'C++',
  sdk: 'SDK',
  ai: 'AI',
  srt: 'SRT',
  vtt: 'VTT',
};

export function formatNodeTitle(rawTitle: string, path: string): string {
  if (!rawTitle) return path.split('/').pop()?.replace(/\.[^/.]+$/, '') || path;
  const trimmed = rawTitle.trim();
  if (/\p{Script=Han}/u.test(trimmed)) return trimmed;

  const lower = trimmed.toLowerCase();
  if (lower === 'index' || lower === 'index.md' || lower === 'index.mdx') {
    return path.includes('/usage/') ? '使用概览' : 'Introduction';
  }
  if (lower === 'readme' || lower === 'readme.md') {
    return 'README';
  }

  const stripped = trimmed.replace(/^\d+[\s._-]+/, '');

  const words = stripped
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return trimmed;

  return words
    .map((w) => {
      const wLower = w.toLowerCase();
      if (TECH_ACRONYMS[wLower]) return TECH_ACRONYMS[wLower];
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

function chapterDisplayTitle(title: string, teachingOrder: number): string {
  const parsed = parseChapterTitle(title);
  const clean = parsed.cleanTitle || title;
  const order = parsed.index ? parseInt(parsed.index, 10) : teachingOrder;
  return order > 0 ? `第 ${order} 章：${clean}` : clean;
}

const MAX_COGNITIVE_CHAPTER_NODES = 12;

function chunkNodes<T>(items: T[], targetSize = 10, maxSize = 12): T[][] {
  if (items.length <= maxSize) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += targetSize) {
    chunks.push(items.slice(i, i + targetSize));
  }
  if (chunks.length > 1 && chunks[chunks.length - 1].length < 3) {
    const last = chunks.pop()!;
    chunks[chunks.length - 1].push(...last);
  }
  return chunks;
}

function getTopologyGroupKey(path: string): string {
  if (!path) return 'root';
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return 'root';

  if (parts.includes('i18n')) {
    const i18nIdx = parts.indexOf('i18n');
    const lang = parts[i18nIdx + 1] || 'i18n';
    return `i18n/${lang}`;
  }

  const first = parts[0];
  const second = parts[1];

  const CONTAINER_DIRS = ['docs', 'packages', 'apps', 'modules', 'src', 'sdk', 'crates', 'libs'];
  if (CONTAINER_DIRS.includes(first.toLowerCase()) && second && parts.length > 2) {
    return `${first}/${second}`;
  }

  return first;
}

function humanizeGroupKey(key: string, parentChapterTitle: string): string {
  if (key === 'root') return parentChapterTitle;
  const lastSeg = key.split('/').pop() || key;
  const formatted = formatNodeTitle(lastSeg.replace(/^\./, ''), key);
  return `${parentChapterTitle} · ${formatted}`;
}

function balanceOutlineChapters(chapters: RelayOutlineChapterItem[]): RelayOutlineChapterItem[] {
  const result: RelayOutlineChapterItem[] = [];
  let globalOrder = 0;

  for (const chapter of chapters) {
    if (chapter.nodes.length <= MAX_COGNITIVE_CHAPTER_NODES) {
      globalOrder++;
      result.push({
        ...chapter,
        title: chapterDisplayTitle(chapter.title, globalOrder),
        teachingOrder: globalOrder,
      });
      continue;
    }

    const groupMap = new Map<string, RelayOutlineNodeItem[]>();
    for (const node of chapter.nodes) {
      const gKey = getTopologyGroupKey(node.path);
      if (!groupMap.has(gKey)) groupMap.set(gKey, []);
      groupMap.get(gKey)!.push(node);
    }

    const parsed = parseChapterTitle(chapter.title);
    const clean = parsed.cleanTitle || chapter.title;

    if (groupMap.size <= 1) {
      const chunks = chunkNodes(chapter.nodes, 10, MAX_COGNITIVE_CHAPTER_NODES);
      chunks.forEach((chunk, idx) => {
        globalOrder++;
        const subTitle = chunks.length > 1 ? `${clean} (第 ${idx + 1} 部分)` : clean;
        result.push({
          id: `${chapter.id}-part-${idx + 1}`,
          title: `第 ${globalOrder} 章：${subTitle}`,
          teachingOrder: globalOrder,
          nodes: chunk,
        });
      });
      continue;
    }

    const MIN_CHAPTER_SIZE = 3;
    const finalGroups: Array<{ title: string; nodes: RelayOutlineNodeItem[] }> = [];
    const smallAccumulator: RelayOutlineNodeItem[] = [];

    for (const [gKey, gNodes] of groupMap.entries()) {
      if (gNodes.length >= MIN_CHAPTER_SIZE) {
        if (gNodes.length > MAX_COGNITIVE_CHAPTER_NODES) {
          const subChunks = chunkNodes(gNodes, 10, MAX_COGNITIVE_CHAPTER_NODES);
          subChunks.forEach((chunk, idx) => {
            const subTitle = subChunks.length > 1 ? `${humanizeGroupKey(gKey, clean)} (第 ${idx + 1} 部分)` : humanizeGroupKey(gKey, clean);
            finalGroups.push({ title: subTitle, nodes: chunk });
          });
        } else {
          finalGroups.push({ title: humanizeGroupKey(gKey, clean), nodes: gNodes });
        }
      } else {
        smallAccumulator.push(...gNodes);
      }
    }

    if (smallAccumulator.length > 0) {
      if (smallAccumulator.length >= MIN_CHAPTER_SIZE) {
        finalGroups.push({ title: `${clean} · 核心参考`, nodes: smallAccumulator });
      } else if (finalGroups.length > 0) {
        finalGroups[0].nodes.push(...smallAccumulator);
      } else {
        finalGroups.push({ title: clean, nodes: smallAccumulator });
      }
    }

    for (const grp of finalGroups) {
      globalOrder++;
      result.push({
        id: `${chapter.id}-grp-${globalOrder}`,
        title: `第 ${globalOrder} 章：${grp.title}`,
        teachingOrder: globalOrder,
        nodes: grp.nodes,
      });
    }
  }

  return result;
}

export const GET = defineRoute({
  scope: 'GET /api/update/jobs',
  auth: 'public',
  handler: async ({ request, userId }) => {
    const { searchParams } = new URL(request.url);
    const owner = searchParams.get('owner');
    const repoName = searchParams.get('repo');
    const edition = searchParams.get('edition');
    if (!owner || !repoName) {
      throw ApiError.badRequest('Missing owner/repo');
    }

    const repository = await prisma.repository.findFirst({
      where: {
        owner,
        repo: repoName,
        branch: ENGINE_CONFIG.defaultBranch,
        ...(edition !== null ? { edition } : {}),
      },
      select: { id: true, owner: true, repo: true, isPublic: true, repoProfile: true, qualityHold: true },
    });
    if (!repository) {
      throw ApiError.notFound('Repository not found');
    }
    if (!(await verifyRepoAccessDirect(repository, userId ?? undefined))) {
      throw ApiError.forbidden('Forbidden');
    }

    const { executeSidecarMarketJobsList } = await import('@/engine/market-driver');
    const [jobsResult, documents, outline] = await Promise.all([
      executeSidecarMarketJobsList(repository.id).catch(() => ({ jobs: [] })),
      prisma.document.findMany({
        where: { repositoryId: repository.id, ownerUserId: null },
        select: { id: true, path: true, title: true, status: true },
      }),
      getActiveOutline(repository.id),
    ]);
    const jobs = jobsResult.jobs;

    const versionCountMap = new Map<string, number>();
    if (documents.length > 0) {
      const grouped = await prisma.chapterVersion.groupBy({
        by: ['documentId'],
        where: {
          documentId: { in: documents.map((d) => d.id) },
          visibility: 'PUBLIC',
        },
        _count: { _all: true },
      });
      for (const row of grouped) {
        versionCountMap.set(row.documentId, row._count._all);
      }
    }

    const docById = new Map(documents.map((d) => [d.id, d]));
    const activeJobByDocId = new Map<string, (typeof jobs)[number]>();
    for (const job of jobs) {
      if (job.documentId && !activeJobByDocId.has(job.documentId)) {
        activeJobByDocId.set(job.documentId, job);
      }
    }

    const toNodeItem = (documentId: string, fallbackTitle: string): RelayOutlineNodeItem => {
      const doc = docById.get(documentId);
      const activeJob = activeJobByDocId.get(documentId);
      const processed = doc?.status === 'PROCESSED';
      const inFlight = activeJob?.status === 'CLAIMED' || activeJob?.status === 'TRIAL';
      const docPath = doc?.path ?? '';
      const rawTitle = fallbackTitle?.trim() || doc?.title?.trim() || docPath;
      return {
        id: documentId,
        documentId,
        title: formatNodeTitle(rawTitle, docPath),
        path: docPath,
        status: processed ? 'PROCESSED' : inFlight ? 'CLAIMED' : 'UNPROCESSED',
        versionCount: versionCountMap.get(documentId) ?? 0,
        claimedBy: activeJob?.claimedBy ?? null,
        jobId: activeJob?.id ?? null,
      };
    };

    let outlineItems: RelayOutlineChapterItem[];
    if (outline) {
      outlineItems = allChaptersInTeachingOrder(outline).map((chapter, index) => {
        const order = chapter.teachingOrder || index + 1;
        return {
          id: chapter.id,
          title: chapterDisplayTitle(chapter.title, order),
          teachingOrder: order,
          nodes: chapter.nodes
            .filter((node) => node.documentId && node.docPath)
            .map((node) => toNodeItem(node.documentId as string, node.title)),
        };
      });
    } else {
      const rawNodes = [...documents]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((doc) => toNodeItem(doc.id, doc.path.split('/').pop()?.replace(/\.(md|mdx|markdown|rst|adoc|tex|txt)$/i, '') || doc.path));
      outlineItems = balanceOutlineChapters([
        {
          id: 'full-outline',
          title: '全书章节大纲',
          teachingOrder: 1,
          nodes: rawNodes,
        },
      ]);
    }

    const allNodes = outlineItems.flatMap((ch) => ch.nodes);
    const totalDocs = allNodes.length;
    const processedDocs = allNodes.filter((n) => n.status === 'PROCESSED').length;

    return ok({
      repo: {
        owner: repository.owner,
        repo: repository.repo,
        title: profileString(repository.repoProfile, ['siteTitle', 'title']) || `${repository.owner}/${repository.repo}`,
        description: profileString(repository.repoProfile, ['description', 'summary']),
        totalDocs,
        processedDocs,
        progressPercent: formatProgressPercent(processedDocs, totalDocs),
        qualityHold: repository.qualityHold,
      },
      outline: outlineItems,
      jobs,
    } satisfies RelayWorkbenchResponse);
  },
});
