import { MODULE_ROLE_PATTERNS } from '@/engine/language-map';
import type { NavNode } from '@/engine/structurizer';

export interface OutlineNodeView {
  id: string;
  title: string;
  nodeType: string;
  headingPath: string | null;
  documentId: string | null;
  docPath: string | null;
  docStatus: string | null;
}

export interface OutlineChapterView {
  id: string;
  title: string;
  summary: string | null;
  chapterType: string;
  moduleName?: string | null;
  teachingOrder: number;
  nodes: OutlineNodeView[];
}

export interface OutlinePartView {
  id: string;
  title: string;
  summary: string | null;
  teachingOrder: number;
  chapters: OutlineChapterView[];
}

export interface OutlineView {
  outlineId: string;
  version: number;
  mode: string;
  parts: OutlinePartView[];
  chapters: OutlineChapterView[];
}

export const outlineActiveCacheTag = (repositoryId: string): string => `outline-active:${repositoryId}`;

export async function getActiveOutline(repositoryId: string): Promise<OutlineView | null> {
  const { getWebL1OutlineProjectionById } = await import('@/lib/docs/web-outline-projection');
  const l1Proj = await getWebL1OutlineProjectionById(repositoryId);
  if (l1Proj?.outline && l1Proj.outline.outlineId) {
    return l1Proj.outline;
  }

  const { unstable_cache } = await import('next/cache');
  const { ENGINE_CONFIG } = await import('@/lib/config');
  const cached = unstable_cache(
    () => buildActiveOutline(repositoryId),
    ['outline-active', repositoryId],
    {
      revalidate: ENGINE_CONFIG.docsRead.outlineCacheTtlSeconds,
      tags: [outlineActiveCacheTag(repositoryId)],
    },
  );
  return cached().catch((err: unknown) => {
    console.warn('[OutlineReader] cache read failed, querying directly:', err);
    return buildActiveOutline(repositoryId);
  });
}

async function buildActiveOutline(repositoryId: string): Promise<OutlineView | null> {
  const { callSidecar } = await import('@/lib/sidecar-client');
  try {
    const res = await callSidecar<{ ok: boolean; outline: OutlineView | null }>(
      '/v1/outline/active',
      { repositoryId },
      { label: 'outline-reader /v1/outline/active', timeoutMs: 5_000 }
    );
    return res.outline ?? null;
  } catch (err) {
    console.warn('[OutlineReader] sidecar outline read failed:', err);
    return null;
  }
}

export function allChaptersInTeachingOrder(outline: OutlineView): OutlineChapterView[] {
  return [...(outline.chapters || []), ...(outline.parts || []).flatMap((p) => p.chapters || [])].sort(
    (a, b) => a.teachingOrder - b.teachingOrder,
  );
}

const ALL_DOC_EXTENSIONS = ['.md', '.mdx', '.markdown', '.rst', '.adoc', '.tex', '.txt'];

export function docPathToSlug(docPath?: string | null): string {
  if (!docPath) return '';
  const lower = docPath.toLowerCase();
  for (const ext of ALL_DOC_EXTENSIONS) {
    if (lower.endsWith(ext)) return docPath.slice(0, -ext.length);
  }
  for (const ext of MODULE_ROLE_PATTERNS.markdownExtensions) {
    if (lower.endsWith(ext)) return docPath.slice(0, -ext.length);
  }
  return docPath;
}

export function outlineNodeUrl(owner: string, repo: string, docPath: string | null): string {
  if (!docPath) return '';
  const slug = docPathToSlug(docPath);
  if (!slug || slug.toLowerCase() === 'index' || slug.toLowerCase() === 'readme') {
    return `/docs/${owner}/${repo}`;
  }
  return `/docs/${owner}/${repo}/${slug}`;
}

export function resolveDocPathFromOutline(outline: OutlineView, rawPath: string): string | null {
  const target = rawPath.replace(/^\/+|\/+$/g, '');
  const isRootTarget = !target || target.toLowerCase() === 'index' || target.toLowerCase() === 'readme';
  for (const ch of allChaptersInTeachingOrder(outline)) {
    for (const n of ch.nodes) {
      if (!n.docPath) continue;
      const slug = docPathToSlug(n.docPath).replace(/^\/+|\/+$/g, '');
      if (slug === target) return n.docPath;
      if (isRootTarget && (slug.toLowerCase() === 'index' || slug.toLowerCase() === 'readme')) {
        return n.docPath;
      }
    }
  }
  return null;
}

export function firstNavigableNode(outline: OutlineView): OutlineNodeView | null {
  for (const ch of allChaptersInTeachingOrder(outline)) {
    for (const n of ch.nodes) {
      if (n.docPath) return n;
    }
  }
  return null;
}

export interface AdjacentOutlineNodes {
  prev: OutlineNodeView | null;
  next: OutlineNodeView | null;
}

export function adjacentNavigableNodes(outline: OutlineView, currentDocPath: string): AdjacentOutlineNodes {
  const sequence: OutlineNodeView[] = [];
  for (const ch of allChaptersInTeachingOrder(outline)) {
    for (const n of ch.nodes) {
      if (n.docPath) sequence.push(n);
    }
  }
  const index = sequence.findIndex((n) => n.docPath === currentDocPath);
  if (index === -1) return { prev: null, next: null };
  return {
    prev: index > 0 ? sequence[index - 1] : null,
    next: index < sequence.length - 1 ? sequence[index + 1] : null,
  };
}

export interface NavTreeEntry {
  path: string;
  title: string;
}

export function flattenNavTreeEntries(
  nodes: NavNode[] | undefined | null,
  out: NavTreeEntry[] = []
): NavTreeEntry[] {
  for (const node of nodes || []) {
    if (node.type === 'file') {
      out.push({ path: node.path, title: node.shortTitle || node.title || node.path });
    } else if (node.children) {
      flattenNavTreeEntries(node.children, out);
    }
  }
  return out;
}

function flattenNavTreeFiles(nodes: NavNode[] | undefined | null): string[] {
  return flattenNavTreeEntries(nodes).map((e) => e.path);
}

export function outlineTeachingDocPaths(outline: OutlineView): string[] {
  const paths: string[] = [];
  for (const ch of allChaptersInTeachingOrder(outline)) {
    for (const n of ch.nodes) {
      if (n.docPath && !paths.includes(n.docPath)) paths.push(n.docPath);
    }
  }
  return paths;
}

export async function resolveTeachingDocPaths(
  repositoryId: string,
  fallbackNavTree?: unknown
): Promise<string[]> {
  try {
    const outline = await getActiveOutline(repositoryId);
    if (outline) {
      const paths = outlineTeachingDocPaths(outline);
      if (paths.length > 0) return paths;
    }
  } catch (err) {
    console.warn('[outline-reader] Failed to read active outline for teaching order:', err);
  }

  if (fallbackNavTree !== undefined) {
    return flattenNavTreeFiles((fallbackNavTree as NavNode[] | null) || undefined);
  }

  try {
    const { prisma } = await import('@/lib/db');
    if (typeof prisma.repository?.findUnique === 'function') {
      const repo = await prisma.repository.findUnique({
        where: { id: repositoryId },
        select: { navTree: true },
      });
      return flattenNavTreeFiles((repo?.navTree as NavNode[] | null) || undefined);
    }
  } catch (err) {
    console.warn('[outline-reader] Failed to read repository navTree for teaching order fallback:', err);
    return [];
  }
  return [];
}
