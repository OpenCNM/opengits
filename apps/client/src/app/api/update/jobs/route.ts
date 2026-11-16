import { prisma } from '@/lib/db';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { ENGINE_CONFIG } from '@/lib/config';
import { allChaptersInTeachingOrder, getActiveOutline } from '@/lib/outline-reader';

export const dynamic = 'force-dynamic';

/** 接力总图节点：单章节的接力状态与版本/认领事实 */
interface RelayOutlineNodeItem {
  /** documentId（认领入口既可吃 jobId 也可吃 documentId） */
  id: string;
  documentId: string;
  /** 节名称，如 "1_file_import" */
  title: string;
  /** 物理路径，如 "docs/docs/usage/1_file_import.md" */
  path: string;
  /** PROCESSED=已烘焙正典；CLAIMED=认领在途（含存量 TRIAL 排水中）；UNPROCESSED=待开荒 */
  status: 'PROCESSED' | 'CLAIMED' | 'UNPROCESSED';
  /** 该章节公开竞争池中的版本数（ChapterVersion 统计） */
  versionCount: number;
  claimedBy: string | null;
  jobId: string | null;
}

interface RelayOutlineChapterItem {
  id: string;
  /** 如 "第 1 章：项目概览与环境初始化" */
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
    /** 共享章节总量（ownerUserId=null 的 Document） */
    totalDocs: number;
    processedDocs: number;
    progressPercent: number;
    /** 质量熔断标记（复检分跌破线，auto-update 跳过）——维护者可见性 */
    qualityHold: boolean;
  };
  outline: RelayOutlineChapterItem[];
  /** 活跃任务兼容映射（ChapterUpdateJob PENDING/CLAIMED 视图，供旧消费方降级） */
  jobs: unknown[];
}

/** 从 repoProfile JSON 安全取首个非空字符串字段 */
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

/** 节标题轻量美化：将 raw slug（如 "1 file import"、"custom whisper cpp models"）美化为优雅人读标题 */
export function formatNodeTitle(rawTitle: string, path: string): string {
  if (!rawTitle) return path.split('/').pop()?.replace(/\.[^/.]+$/, '') || path;
  const trimmed = rawTitle.trim();
  // 已包含中文或其他非拉丁字符（人工精修标题），原样保留
  if (/\p{Script=Han}/u.test(trimmed)) return trimmed;

  const lower = trimmed.toLowerCase();
  if (lower === 'index' || lower === 'index.md' || lower === 'index.mdx') {
    return path.includes('/usage/') ? '使用概览' : 'Introduction';
  }
  if (lower === 'readme' || lower === 'readme.md') {
    return 'README';
  }

  // 去除物理序数前缀（如 "1 " / "02_" / "3 - "）
  const stripped = trimmed.replace(/^\d+[\s._-]+/, '');

  // 单词边界分割并转 Title Case，同时命中技术缩写
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

/** 大纲章标题格式化：避免原标题已含序数时重复前缀（如 "第 1 章：第 1 章：..."） */
function chapterDisplayTitle(title: string, teachingOrder: number): string {
  const parsed = parseChapterTitle(title);
  const clean = parsed.cleanTitle || title;
  const order = parsed.index ? parseInt(parsed.index, 10) : teachingOrder;
  return order > 0 ? `第 ${order} 章：${clean}` : clean;
}

const MAX_COGNITIVE_CHAPTER_NODES = 12;

/** 均衡分块工具函数：保证切块不产生 < 3 节的碎尾 */
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

/** 从路径中提取最具架构辨识度的拓扑分组键 */
function getTopologyGroupKey(path: string): string {
  if (!path) return 'root';
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return 'root';

  // 识别国际化/多语言目录（如 docs/i18n/zh/...）
  if (parts.includes('i18n')) {
    const i18nIdx = parts.indexOf('i18n');
    const lang = parts[i18nIdx + 1] || 'i18n';
    return `i18n/${lang}`;
  }

  const first = parts[0];
  const second = parts[1];

  // 顶层容器目录（docs, apps, sdk, packages, src 等）：取前两级作为二级教学单元
  const CONTAINER_DIRS = ['docs', 'packages', 'apps', 'modules', 'src', 'sdk', 'crates', 'libs'];
  if (CONTAINER_DIRS.includes(first.toLowerCase()) && second && parts.length > 2) {
    return `${first}/${second}`;
  }

  return first;
}

/** 将拓扑目录 key 转化为优雅的人读章节子标题 */
function humanizeGroupKey(key: string, parentChapterTitle: string): string {
  if (key === 'root') return parentChapterTitle;
  const lastSeg = key.split('/').pop() || key;
  const formatted = formatNodeTitle(lastSeg.replace(/^\./, ''), key);
  return `${parentChapterTitle} · ${formatted}`;
}

/**
 * 第一性原理认知平衡器：
 * 当任何仓库的大纲单章节点数超过认知上限（12 节）时，
 * 依据文件目录拓扑 DAG 进行确定性二级子单元投影，
 * 彻底消除「一章塞全书」的贪婪黑洞缺陷。
 */
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

    // 节点数超标，按目录拓扑分组
    const groupMap = new Map<string, RelayOutlineNodeItem[]>();
    for (const node of chapter.nodes) {
      const gKey = getTopologyGroupKey(node.path);
      if (!groupMap.has(gKey)) groupMap.set(gKey, []);
      groupMap.get(gKey)!.push(node);
    }

    const parsed = parseChapterTitle(chapter.title);
    const clean = parsed.cleanTitle || chapter.title;

    // 如果所有文件都在同一个目录无法按路径细分，按每 10 节切块
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

    // 拓扑分组成功：每个组成为一个子教学单元，微小群组（< 3 节）聚合避免过度碎片化
    const MIN_CHAPTER_SIZE = 3;
    const finalGroups: Array<{ title: string; nodes: RelayOutlineNodeItem[] }> = [];
    const smallAccumulator: RelayOutlineNodeItem[] = [];

    for (const [gKey, gNodes] of groupMap.entries()) {
      if (gNodes.length >= MIN_CHAPTER_SIZE) {
        // 如果组内节点仍超标，按 10 节切分
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

    // 零散小文件集中聚合，避免生成多个重复标题的碎片章
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

/**
 * GET /api/update/jobs?owner=&repo= —— 接力工作台「大纲接力总图」。
 * 返回全书完整大纲结构（激活 TutorialOutline > 兜底 Document 平铺）与每个
 * 节点的接力状态（PROCESSED/CLAIMED/UNPROCESSED）、版本数、认领人——未建单
 * 的待转录章节不再丢失。旧的试读表决视图已退役：转录过机检即入库为
 * ChapterVersion，读者在正文详情页切换版本并点赞。
 */
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

    // 三路并行：活跃任务（认领/在途映射）+ 共享章节全集 + 激活大纲（编排层）
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

    // 版本数：公开竞争池口径（PRIVATE 版本仅作者可见，不对外计数）
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
    // documentId → 活跃任务（认领人/任务号挂载；同文档多活跃任务取首条）
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
      // 优先大纲编排层教学意图标题（fallbackTitle，来自 OutlineNode.title），仅在未编排时降级至物理 Document 文件名
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
      // 无激活大纲（存量 V1 仓）：共享章节按路径序平铺，经 balanceOutlineChapters 拓扑聚合
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
