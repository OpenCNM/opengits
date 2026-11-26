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

export function projectNavTreeFromOutline(
  outline: OutlineView,
  repoInfo: { owner: string; repo: string }
): NavNode[] {
  if (!outline) return [];

  const rootNodes: NavNode[] = [];
  const skipDocPaths = new Set<string>();

  interface OrderedRootItem {
    order: number;
    subOrder?: number;
    node: NavNode;
  }
  const orderedItems: OrderedRootItem[] = [];

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

export async function syncRepositoryNavTreeFromOutline(
  repositoryId: string,
  tx?: DbClient,
  options?: { fallbackNavTree?: unknown; owner?: string; repo?: string; outline?: OutlineView | null }
): Promise<NavNode[]> {
  const db = tx ?? prisma;

  let owner = options?.owner;
  let repo = options?.repo;
  let fallbackTree = options?.fallbackNavTree;

  if (options?.outline) {
    if (!owner || !repo) {
      const repoRecord = typeof db.repository?.findUnique === 'function'
        ? await db.repository.findUnique({
            where: { id: repositoryId },
            select: { owner: true, repo: true },
          }).catch((err) => {
          console.warn('[outline-projector] repository meta lookup failed:', err);
          return null;
        })
        : null;
      owner = owner || repoRecord?.owner || '';
      repo = repo || repoRecord?.repo || '';
    }
    return projectNavTreeFromOutline(options.outline, { owner, repo });
  }

  if (!owner || !repo || fallbackTree === undefined) {
    const repoRecord = typeof db.repository?.findUnique === 'function'
      ? await db.repository.findUnique({
          where: { id: repositoryId },
          select: { owner: true, repo: true, navTree: true },
        }).catch((err) => {
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

  // Zero-materialization: derive NavTree from TutorialOutline without dual-writing repository.navTree.
  return rootNodes;
}

export interface ResolveNavTreeOptions {
  owner?: string;
  repo?: string;
  tx?: DbClient;
  fallbackNavTree?: unknown;
  outline?: OutlineView | null;
}

export async function resolveEffectiveNavTree(
  repositoryId: string,
  options?: ResolveNavTreeOptions
): Promise<NavNode[]> {
  if (options?.tx) {
    return syncRepositoryNavTreeFromOutline(repositoryId, options.tx, options);
  }

  if (options?.outline === undefined) {
    const l1Proj = await getWebL1OutlineProjectionById(repositoryId);
    if (l1Proj && l1Proj.navTree && l1Proj.navTree.length > 0) {
      return l1Proj.navTree;
    }
  }

  let owner = options?.owner;
  let repo = options?.repo;
  const fallbackTree = options?.fallbackNavTree;

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

  if (outline) {
    if (!owner || !repo) {
      const repoRecord = typeof prisma.repository?.findUnique === 'function'
        ? await prisma.repository.findUnique({
            where: { id: repositoryId },
            select: { owner: true, repo: true },
          }).catch((err) => {
          console.warn('[outline-projector] repository meta lookup failed:', err);
          return null;
        })
        : null;
      owner = owner || repoRecord?.owner || '';
      repo = repo || repoRecord?.repo || '';
    }
    return projectNavTreeFromOutline(outline, { owner, repo });
  }

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
      console.warn('[outline-projector] repository owner/repo lookup failed:', err);
      repoRecord = null;
    }
  }

  const effectiveFallback = fallbackTree !== undefined ? fallbackTree : repoRecord?.navTree;

  if (Array.isArray(effectiveFallback) && effectiveFallback.length > 0) {
    return effectiveFallback as unknown as NavNode[];
  }

  const overviewDoc = typeof prisma.document?.findFirst === 'function'
    ? await Promise.resolve(
        prisma.document.findFirst({
          where: { repositoryId, path: 'architecture-overview' },
          select: { title: true, path: true },
        })
      ).catch((err) => {
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

export const getEffectiveNavTree = resolveEffectiveNavTree;

