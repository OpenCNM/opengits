/**
 * 大纲 ➔ NavTree 单向确定性投影器 (Outline-to-NavTree Projector)
 *
 * 职责：
 * 1. 提供纯函数 projectNavTreeFromOutline，将 TutorialOutline (OutlineView) 确定性
 *    投影为符合阅读器与 Go sidecar 契约的树形 NavNode 结构；
 *    - 顶层 Overview 节点优先放置（若是 explorer 模式或具备概览文档）；
 *    - 支持嵌套大类（parts）与平铺章节（chapters）；
 *    - 单节点扁平化（章仅包含 1 个同名节时直接扁平为 file 节点）；
 *    - 统一 slug 规约与标题规约；
 * 2. 提供事务安全的 syncRepositoryNavTreeFromOutline 与统一只读入口 getEffectiveNavTree，
 *    确立 TutorialOutline 为唯一持久化源，彻底切除 repository.navTree 物理写盘双写。
 */

import { prisma } from '@/lib/db';
import type { Prisma } from '@prisma/client';
import type { NavNode } from '@/engine/structurizer';
import {
  docPathToSlug,
  getActiveOutline,
  type OutlineView,
  type OutlineChapterView,
  type OutlinePartView,
} from '@/lib/outline-reader';
import { getWebL1OutlineProjectionById } from '@/lib/docs/web-outline-projection';

export type DbClient = typeof prisma | Prisma.TransactionClient;

/**
 * 将单个章视图（OutlineChapterView）投影为 NavNode
 * - 当章内仅包含 1 个可导航节且标题与章相符（或章无标题）时，自动扁平化为 file 节点；
 * - 否则作为 directory 节点，包含所有可导航子节。
 */
function projectChapterToNavNode(
  chapter: OutlineChapterView,
  repoInfo: { owner: string; repo: string },
  skipDocPaths?: Set<string>
): NavNode | null {
  const validChildren: NavNode[] = [];
  for (const node of chapter.nodes || []) {
    const docPath = node.docPath || (node as any).document?.path;
    if (docPath) {
      const cleanSlug = docPathToSlug(docPath).replace(/^\/+/, '');
      if (skipDocPaths?.has(docPath) || skipDocPaths?.has(cleanSlug)) {
        continue;
      }
      const nodeTitle = node.title || (node as any).document?.title || docPath;
      validChildren.push({
        name: docPath.split('/').pop() || docPath,
        title: nodeTitle,
        type: 'file',
        path: docPath,
        url: cleanSlug
          ? `/docs/${repoInfo.owner}/${repoInfo.repo}/${cleanSlug}`
          : `/docs/${repoInfo.owner}/${repoInfo.repo}`,
      });
    }
  }

  if (validChildren.length === 0) {
    return null;
  }

  // 单节点扁平化
  if (validChildren.length === 1 && (validChildren[0].title === chapter.title || !chapter.title)) {
    return validChildren[0];
  }

  return {
    name: chapter.title,
    title: chapter.title,
    type: 'directory',
    path: '',
    url: '',
    children: validChildren,
  };
}

/**
 * 纯函数：将 OutlineView 确定性投影为 NavNode 树结构
 */
export function projectNavTreeFromOutline(
  outline: OutlineView,
  repoInfo: { owner: string; repo: string }
): NavNode[] {
  if (!outline) return [];

  const rootNodes: NavNode[] = [];
  const skipDocPaths = new Set<string>();

  // 2. 收集大类与顶层章节并按 teachingOrder 排序组装
  interface OrderedRootItem {
    order: number;
    subOrder?: number;
    node: NavNode;
  }
  const orderedItems: OrderedRootItem[] = [];

  // 2.1 嵌套大类投影
  for (const part of outline.parts || []) {
    const partChildren: NavNode[] = [];
    const sortedChapters = [...(part.chapters || [])].sort(
      (a, b) => (a.teachingOrder ?? 0) - (b.teachingOrder ?? 0) || (a.title || '').localeCompare(b.title || '')
    );
    for (const chapter of sortedChapters) {
      const chapterNode = projectChapterToNavNode(chapter, repoInfo, skipDocPaths);
      if (chapterNode) {
        partChildren.push(chapterNode);
      }
    }
    if (partChildren.length > 0) {
      const firstChapterOrder = sortedChapters[0]?.teachingOrder;
      orderedItems.push({
        order: part.teachingOrder ?? (firstChapterOrder ?? 0),
        subOrder: firstChapterOrder,
        node: {
          name: part.title,
          title: part.title,
          type: 'directory',
          path: '',
          url: '',
          children: partChildren,
        },
      });
    }
  }

  // 2.2 平铺顶层章节投影
  const sortedTopChapters = [...(outline.chapters || [])].sort(
    (a, b) => (a.teachingOrder ?? 0) - (b.teachingOrder ?? 0) || (a.title || '').localeCompare(b.title || '')
  );
  for (const chapter of sortedTopChapters) {
    const chapterNode = projectChapterToNavNode(chapter, repoInfo, skipDocPaths);
    if (chapterNode) {
      orderedItems.push({
        order: chapter.teachingOrder ?? 0,
        subOrder: chapter.teachingOrder ?? 0,
        node: chapterNode,
      });
    }
  }

  orderedItems.sort((a, b) => {
    if (a.order !== b.order) {
      return a.order - b.order;
    }
    if (a.subOrder !== undefined && b.subOrder !== undefined && a.subOrder !== b.subOrder) {
      return a.subOrder - b.subOrder;
    }
    const titleA = a.node.title || a.node.name || '';
    const titleB = b.node.title || b.node.name || '';
    return titleA.localeCompare(titleB);
  });
  rootNodes.push(...orderedItems.map((item) => item.node));

  return rootNodes;
}

function assembleOutlineView(
  outline: any,
  repositoryId: string,
): OutlineView {
  const parts: OutlinePartView[] = (outline.parts || []).map((p: any) => ({
    id: p.id,
    title: p.title,
    summary: p.summary,
    teachingOrder: p.teachingOrder,
    chapters: [],
  }));
  const partIndex = new Map(parts.map((p) => [p.id, p]));

  const topLevelChapters: OutlineChapterView[] = [];
  for (const ch of outline.chapters || []) {
    const view: OutlineChapterView = {
      id: ch.id,
      title: ch.title,
      summary: ch.summary,
      chapterType: ch.chapterType,
      moduleName: ch.moduleName ?? null,
      teachingOrder: ch.teachingOrder,
      nodes: (ch.nodes || []).map((n: any) => ({
        id: n.id,
        title: n.title,
        nodeType: n.nodeType,
        headingPath: n.headingPath,
        documentId: n.documentId,
        docPath: n.document?.path ?? n.docPath ?? null,
        docStatus: n.document?.status ?? null,
        ...(n.document ? { document: n.document } : {}),
      })),
    };
    const part = ch.partId ? partIndex.get(ch.partId) : undefined;
    if (part) {
      part.chapters.push(view);
    } else {
      topLevelChapters.push(view);
    }
  }

  return {
    outlineId: outline.id,
    version: outline.version,
    mode: outline.mode,
    parts: parts.filter((p) => p.chapters.length > 0),
    chapters: topLevelChapters,
  };
}

/**
 * 从当前激活的 TutorialOutline 纯函数计算 NavTree 投影（去物化零写库）
 */
export async function syncRepositoryNavTreeFromOutline(
  repositoryId: string,
  tx?: DbClient,
  options?: { fallbackNavTree?: unknown; owner?: string; repo?: string; outline?: OutlineView | null }
): Promise<NavNode[]> {
  const db = tx ?? prisma;

  let owner = options?.owner;
  let repo = options?.repo;
  let fallbackTree = options?.fallbackNavTree;

  // 若显式传入 outline 视图，直接纯函数投影
  if (options?.outline) {
    if (!owner || !repo) {
      const repoRecord = typeof db.repository?.findUnique === 'function'
        ? await db.repository.findUnique({
            where: { id: repositoryId },
            select: { owner: true, repo: true },
          }).catch((err) => {
          // 容错降级: 仓库元信息查询失败退化为空（导航树链接将缺宿主字段），留痕观测
          console.warn('[outline-projector] repository meta lookup failed:', err);
          return null;
        })
        : null;
      owner = owner || repoRecord?.owner || '';
      repo = repo || repoRecord?.repo || '';
    }
    return projectNavTreeFromOutline(options.outline, { owner, repo });
  }

  // 1. 获取仓库信息以构建标准 url
  if (!owner || !repo || fallbackTree === undefined) {
    const repoRecord = typeof db.repository?.findUnique === 'function'
      ? await db.repository.findUnique({
          where: { id: repositoryId },
          select: { owner: true, repo: true, navTree: true },
        }).catch((err) => {
          // 容错降级: 仓库元信息查询失败退化为空（导航树链接将缺宿主字段），留痕观测
          console.warn('[outline-projector] repository meta lookup failed:', err);
          return null;
        })
      : null;
    owner = owner || repoRecord?.owner || '';
    repo = repo || repoRecord?.repo || '';
    if (fallbackTree === undefined) {
      fallbackTree = repoRecord?.navTree;
    }
  }

  // 3. 查找当前激活的大纲及其层级关系（若已预载为 null 则跳过）
  let outline: any = null;
  if (options?.outline === undefined) {
    outline = await db.tutorialOutline.findFirst({
      where: { repositoryId, isActive: true },
      orderBy: { version: 'desc' },
      include: {
        parts: {
          orderBy: { teachingOrder: 'asc' },
        },
        chapters: {
          orderBy: { teachingOrder: 'asc' },
          include: {
            nodes: {
              orderBy: { teachingOrder: 'asc' },
              include: {
                document: { select: { id: true, path: true, title: true, status: true } },
              },
            },
          },
        },
      },
    });
  }

  let rootNodes: NavNode[] = [];

  if (!outline) {
    if (Array.isArray(fallbackTree) && fallbackTree.length > 0) {
      rootNodes = fallbackTree as unknown as NavNode[];
    }
  } else {
    const outlineView = assembleOutlineView(outline, repositoryId);
    rootNodes = projectNavTreeFromOutline(outlineView, { owner, repo });
  }

  // 零物化（Zero-Materialization）：彻底移除向 repository.update 的双写落盘，
  // 确立 TutorialOutline 为唯一写事实源，直接返回纯函数实时投影
  return rootNodes;
}

export interface ResolveNavTreeOptions {
  owner?: string;
  repo?: string;
  tx?: DbClient;
  fallbackNavTree?: unknown;
  outline?: OutlineView | null;
}


/**
 * 统一只读入口：获取当前仓库的有效导航树（纯函数实时投影）
 * 1. 若显式传入预载的 options.outline，直接纯函数投影，0 额外数据库查询；
 * 2. 否则优先从当前激活的 TutorialOutline 纯函数实时投影；
 * 3. 若当前无激活大纲（历史冷旧仓），透明回退读取传入的 fallbackNavTree 或查询 repository.navTree；
 * 4. 若既无大纲亦无 navTree 但有 architecture-overview 文档，回退合成概览单节点；
 * 5. 零物理落盘，零行锁竞争。
 */
export async function resolveEffectiveNavTree(
  repositoryId: string,
  options?: ResolveNavTreeOptions
): Promise<NavNode[]> {
  if (options?.tx) {
    return syncRepositoryNavTreeFromOutline(repositoryId, options.tx, options);
  }

  // 0. 优先命中 L1 内存投影（0 数据库查询，0 递归重算；显式传入自定义大纲时跳过以保实时投影）
  if (options?.outline === undefined) {
    const l1Proj = await getWebL1OutlineProjectionById(repositoryId);
    if (l1Proj && l1Proj.navTree && l1Proj.navTree.length > 0) {
      return l1Proj.navTree;
    }
  }

  let owner = options?.owner;
  let repo = options?.repo;
  const fallbackTree = options?.fallbackNavTree;

  // 1. 优先读取大纲：若 options.outline 显式传入（包括预载确认的 null），直接使用；否则从 getActiveOutline 查询
  let outline: OutlineView | null = null;
  if (options?.outline !== undefined) {
    outline = options.outline;
  } else {
    try {
      outline = await getActiveOutline(repositoryId);
    } catch (err) {
      console.warn(`[resolveEffectiveNavTree] Failed to read active outline for ${repositoryId}:`, err);
      outline = null;
    }
  }

  // 2. 命中大纲：纯函数实时投影（若已传 owner & repo 则 0 数据库查询）
  if (outline) {
    if (!owner || !repo) {
      const repoRecord = typeof prisma.repository?.findUnique === 'function'
        ? await prisma.repository.findUnique({
            where: { id: repositoryId },
            select: { owner: true, repo: true },
          }).catch((err) => {
          // 容错降级: 仓库元信息查询失败退化为空（导航树链接将缺宿主字段），留痕观测
          console.warn('[outline-projector] repository meta lookup failed:', err);
          return null;
        })
        : null;
      owner = owner || repoRecord?.owner || '';
      repo = repo || repoRecord?.repo || '';
    }
    return projectNavTreeFromOutline(outline, { owner, repo });
  }

  // 3. 未命中大纲（历史冷旧仓）：回退读取 options.fallbackNavTree 或查询 repository.navTree
  if (fallbackTree !== undefined && Array.isArray(fallbackTree) && fallbackTree.length > 0) {
    return fallbackTree as NavNode[];
  }

  let repoRecord: { owner: string; repo: string; navTree: any; repoProfile?: any } | null = null;
  if ((fallbackTree === undefined || !owner || !repo) && typeof prisma.repository?.findUnique === 'function') {
    try {
      repoRecord = await prisma.repository.findUnique({
        where: { id: repositoryId },
        select: { owner: true, repo: true, navTree: true, repoProfile: true },
      });
      owner = owner || repoRecord?.owner || '';
      repo = repo || repoRecord?.repo || '';
    } catch (err) {
      // 容错降级: owner/repo 元信息查询失败时退化为空值（导航树链接将缺宿主字段），留痕观测
      console.warn('[outline-projector] repository owner/repo lookup failed:', err);
      repoRecord = null;
    }
  }

  const effectiveFallback = fallbackTree !== undefined ? fallbackTree : repoRecord?.navTree;

  if (Array.isArray(effectiveFallback) && effectiveFallback.length > 0) {
    return effectiveFallback as unknown as NavNode[];
  }

  // 4. 若既无大纲也无完整 navTree，但存在概览文档，回退概览单节点
  const overviewDoc = typeof prisma.document?.findFirst === 'function'
    ? await Promise.resolve(
        prisma.document.findFirst({
          where: { repositoryId, path: 'architecture-overview' },
          select: { title: true, path: true },
        })
      ).catch((err) => {
        // 容错降级: 概览文档查询失败退化为空（跳过单节点回退），留痕观测
        console.warn('[outline-projector] overview doc lookup failed:', err);
        return null;
      })
    : null;
  if (overviewDoc) {
    return [
      {
        name: 'architecture-overview',
        title: overviewDoc.title || 'Architecture Overview',
        type: 'file',
        path: overviewDoc.path,
        url: `/docs/${owner}/${repo}/architecture-overview`,
      },
    ];
  }

  // 5. 兜底容灾：若既无大纲也无 navTree，但该仓存在 Document 实体记录，动态派生目录树并异步自愈，坚决不误判为空仓
  if (typeof prisma.document?.findMany === 'function') {
    try {
      const rawDocs = await prisma.document.findMany({
        where: { repositoryId },
        select: { path: true, title: true },
        take: 300,
        orderBy: { path: 'asc' },
      });
      if (rawDocs.length > 0) {
        let orderUrls: string[] | undefined;
        try {
          if (!repoRecord && typeof prisma.repository?.findUnique === 'function') {
            repoRecord = await prisma.repository.findUnique({
              where: { id: repositoryId },
              select: { owner: true, repo: true, navTree: true, repoProfile: true },
            });
          }
          const profileRaw = (repoRecord as any)?.repoProfile;
          const profileObj = typeof profileRaw === 'string' ? JSON.parse(profileRaw) : profileRaw;
          if (Array.isArray(profileObj?.navOrderUrls) && profileObj.navOrderUrls.length > 0) {
            orderUrls = profileObj.navOrderUrls;
          }
        } catch (err) {
          // 容错降级: 读取 profile 中的 navOrderUrls 失败时回退为无顺序信号，留痕观测
          console.warn('[outline-projector] failed to parse profile navOrderUrls:', err);
        }
        const { buildWebNavTree } = await import('@/engine/web-doc/structurizer');
        const items = rawDocs.map((d) => ({
          url: '',
          path: d.path,
          title: d.title || '',
          markdown: '',
          contentHash: '',
          headings: [],
        }));
        const rawTree = buildWebNavTree(items, { orderUrls });
        const mapNode = (node: any): NavNode => {
          const isFile = node.type === 'file';
          const cleanPath = (node.path || '').replace(/\.mdx?$/, '');
          return {
            name: node.name,
            title: node.title,
            type: node.type,
            path: node.path,
            url: isFile && owner && repo ? `/docs/${owner}/${repo}/${cleanPath}` : '',
            ...(node.indexPath ? { indexPath: node.indexPath, indexTitle: node.indexTitle } : {}),
            children: node.children ? node.children.map(mapNode) : undefined,
          } as NavNode;
        };
        const dynamicNavTree = rawTree.map(mapNode);

        // 异步自愈写回大纲（不阻塞当前读取响应）
        import('@/lib/mcp/outline-derive')
          .then(({ outlineFromNavTree }) => {
            const draft = outlineFromNavTree(rawTree as any);
            if (draft.chapters.length > 0) {
              return import('@/lib/mcp/outline-store').then(({ storeOutlineDraft }) =>
                storeOutlineDraft(repositoryId, draft, { isActive: true })
              );
            }
          })
          .catch((err) => {
            console.warn(`[resolveEffectiveNavTree] Self-healing outline draft failed for ${repositoryId}:`, err);
          });

        return dynamicNavTree;
      }
    } catch (err) {
      console.warn(`[resolveEffectiveNavTree] Failed to build fallback tree from documents for ${repositoryId}:`, err);
    }
  }

  return [];
}

/**
 * 统一只读入口向后兼容别名
 */
export const getEffectiveNavTree = resolveEffectiveNavTree;

