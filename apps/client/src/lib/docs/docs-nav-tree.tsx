import React from 'react';
import { SidebarProgressItem } from '@/components/telemetry/SidebarProgressItem';
import {
  outlineNodeUrl,
  allChaptersInTeachingOrder,
  type OutlineView,
  type OutlinePartView,
  type OutlineChapterView,
  type OutlineNodeView,
} from '@/lib/outline-reader';
import { GITHUB_ENDPOINTS } from '@/lib/config';
import { isWebDocRepository } from '@/lib/repository-origin';
import type { NavNode } from '@/engine/structurizer';

export type { NavNode };

export interface BuildPageTreeParams {
  outline: OutlineView | null;
  navTree: NavNode[];
  owner: string;
  repo: string;
  hotPaths: Set<string>;
  repoProfile?: any;
  resolvedBranch?: string | null;
}

export function mapNavNodesToPageTree(
  nodes: NavNode[],
  owner: string,
  repo: string,
  hotPaths: Set<string>,
  repoProfile?: any
): any[] {
  const isWebDoc = isWebDocRepository({ owner, repo, repoProfile });
  return nodes.map((node: any) => {
    if (node.type === 'directory') {
      const indexDocPath = node.indexPath || (/\.(md|mdx|markdown)$/i.test(node.path || '') ? node.path : '');
      const indexUrl = indexDocPath ? outlineNodeUrl(owner, repo, indexDocPath) : '';
      return {
        type: 'folder',
        name: node.title,
        defaultOpen: !isWebDoc,
        ...(indexUrl
          ? {
              index: {
                type: 'page',
                name: node.indexTitle || node.title,
                url: indexUrl,
              },
            }
          : {}),
        children: node.children ? mapNavNodesToPageTree(node.children, owner, repo, hotPaths, repoProfile) : [],
      };
    } else {
      const isHot = Boolean(node.path && hotPaths.has(node.path));
      let nodeUrl = outlineNodeUrl(owner, repo, node.path || '');
      if (node.url) {
        if (/^https?:\/\//i.test(node.url)) {
          nodeUrl = node.url;
        } else {
          const rootUrl = `/docs/${owner}/${repo}`;
          const normalized = node.url.replace(/\/+$/, '');
          const normLower = normalized.toLowerCase();
          const rootLower = rootUrl.toLowerCase();
          if (
            normLower === rootLower ||
            normLower === `${rootLower}/index` ||
            normLower === `${rootLower}/readme`
          ) {
            nodeUrl = rootUrl;
          } else {
            nodeUrl = normalized;
          }
        }
      }
      return {
        type: 'page',
        name: (
          <SidebarProgressItem
            key={node.path || node.name || nodeUrl}
            url={nodeUrl}
            docPath={node.path}
            title={node.shortTitle || node.title}
            isHot={isHot}
            owner={owner}
            repo={repo}
            isWebDoc={isWebDoc}
          />
        ),
        url: nodeUrl,
      };
    }
  });
}

export function mapOutlineToPageTree(
  outline: OutlineView,
  owner: string,
  repo: string,
  hotPaths: Set<string>,
  repoProfile?: any
): any[] {
  const isWebDoc = isWebDocRepository({ owner, repo, repoProfile });
  const nodePage = (n: OutlineNodeView, title: string) => {
    const pageUrl = outlineNodeUrl(owner, repo, n.docPath);
    return {
      type: 'page',
      name: (
        <SidebarProgressItem
          key={n.docPath || n.id || title}
          url={pageUrl}
          docPath={n.docPath ?? undefined}
          title={title}
          isHot={!!(n.docPath && hotPaths.has(n.docPath))}
          owner={owner}
          repo={repo}
          isWebDoc={isWebDoc}
        />
      ),
      url: pageUrl,
    };
  };

  const chapterFolder = (ch: OutlineChapterView): any => {
    const nodes = ch.nodes.filter((n) => n.docPath);
    if (nodes.length === 0) return null;
    const cleanChTitle = ch.title.replace(/^[🔬\s]+/u, '');
    if (nodes.length === 1) return nodePage(nodes[0], cleanChTitle);

    const firstCleanTitle = nodes[0].title.replace(/^(?:🚪\s*(?:\[[^\]]*\])?\s*)/u, '').trim();
    const hasIndexNode = isWebDoc && firstCleanTitle.toLowerCase() === cleanChTitle.trim().toLowerCase();
    const childNodes = hasIndexNode ? nodes.slice(1) : nodes;

    return {
      type: 'folder',
      name: cleanChTitle,
      defaultOpen: !isWebDoc,
      ...(hasIndexNode ? { index: nodePage(nodes[0], cleanChTitle) } : {}),
      children: childNodes.map((n) => nodePage(n, n.title.replace(/^(?:🚪\s*(?:\[[^\]]*\])?\s*)/u, ''))),
    };
  };

  const children: any[] = [];
  const parts = outline.parts || [];
  const topChapters = outline.chapters || [];

  if (isWebDoc && parts.length > 0) {
    // Preserve Part separators for WebDoc sites to mirror upstream hierarchy; flatten code-repo chapters for direct access.
    type TreeBlock =
      | { kind: 'chapter'; order: number; chapter: OutlineChapterView }
      | { kind: 'part'; order: number; part: OutlinePartView };

    const blocks: TreeBlock[] = [];

    for (const ch of topChapters) {
      blocks.push({
        kind: 'chapter',
        order: ch.teachingOrder ?? 0,
        chapter: ch,
      });
    }

    for (const part of parts) {
      const partChapters = part.chapters || [];
      const minChapterOrder = partChapters.reduce(
        (min, c) => Math.min(min, c.teachingOrder ?? Number.MAX_SAFE_INTEGER),
        Number.MAX_SAFE_INTEGER
      );
      const effectiveOrder = minChapterOrder !== Number.MAX_SAFE_INTEGER ? minChapterOrder : (part.teachingOrder ?? 0);
      blocks.push({
        kind: 'part',
        order: effectiveOrder,
        part,
      });
    }

    blocks.sort((a, b) => {
      if (a.order !== b.order) {
        return a.order - b.order;
      }
      if (a.kind === 'chapter' && b.kind === 'part') return -1;
      if (a.kind === 'part' && b.kind === 'chapter') return 1;
      return 0;
    });

    for (const block of blocks) {
      if (block.kind === 'chapter') {
        const folder = chapterFolder(block.chapter);
        if (folder) children.push(folder);
      } else {
        const partChapters = [...(block.part.chapters || [])].sort((a, b) => (a.teachingOrder ?? 0) - (b.teachingOrder ?? 0));
        const renderedChapters: any[] = [];
        for (const ch of partChapters) {
          const folder = chapterFolder(ch);
          if (folder) renderedChapters.push(folder);
        }
        if (renderedChapters.length > 0) {
          children.push({
            type: 'separator',
            name: block.part.title,
          } as any);
          children.push(...renderedChapters);
        }
      }
    }
  } else {
    const allChapters = allChaptersInTeachingOrder(outline);
    for (const ch of allChapters) {
      const folder = chapterFolder(ch);
      if (folder) children.push(folder);
    }
  }

  return children;
}

export function buildFumadocsPageTree(params: BuildPageTreeParams) {
  const { outline, navTree, owner, repo, hotPaths, repoProfile, resolvedBranch } = params;

  const outlineDocPaths: string[] = [];
  if (outline) {
    const chapters = [...(outline.chapters || []), ...(outline.parts || []).flatMap((p) => p.chapters || [])];
    for (const ch of chapters) {
      for (const n of ch.nodes || []) {
        if (n.docPath) outlineDocPaths.push(n.docPath);
      }
    }
  }

  const useOutline =
    outline !== null &&
    (outlineDocPaths.length > 0 ||
      (outline.chapters && outline.chapters.length > 0) ||
      (outline.parts && outline.parts.length > 0));

  const pageTreeChildren = useOutline && outline
    ? mapOutlineToPageTree(outline, owner, repo, hotPaths, repoProfile)
    : mapNavNodesToPageTree(navTree, owner, repo, hotPaths, repoProfile);

  const pdfs = repoProfile?.globalAssets?.pdfs || [];
  const misc = repoProfile?.globalAssets?.misc || [];

  if (pdfs.length > 0 || misc.length > 0) {
    pageTreeChildren.push({ type: 'separator' } as any);

    const endpaperChildren: any[] = [];

    const toExternalAssetUrl = (assetPath: string) => {
      if (/^https?:\/\//i.test(assetPath)) return assetPath;
      if (isWebDocRepository({ owner, repo, repoProfile })) return assetPath;
      return `${GITHUB_ENDPOINTS.web}/${owner}/${repo}/blob/${encodeURIComponent(
        resolvedBranch ?? 'main'
      )}/${assetPath.split('/').map(encodeURIComponent).join('/')}`;
    };

    if (pdfs.length > 0) {
      endpaperChildren.push(
        ...pdfs.map((pdf: any) => ({
          type: 'page',
          name: `📕 ${pdf.lang === 'zh' ? '全书 PDF（中文）' : `PDF (${pdf.lang || 'Unknown'})`}`,
          url: toExternalAssetUrl(pdf.downloadUrl || pdf.path),
          external: true,
        }))
      );
    }

    if (misc.length > 0) {
      endpaperChildren.push(
        ...misc.map((miscPath: string) => {
          const filename = miscPath.split('/').pop() || miscPath;
          return {
            type: 'page',
            name: `📎 ${filename}`,
            url: toExternalAssetUrl(miscPath),
            external: true,
          };
        })
      );
    }

    if (endpaperChildren.length > 0) {
      pageTreeChildren.push({
        type: 'folder',
        name: '📎 附页',
        defaultOpen: false,
        children: endpaperChildren,
      });
    }
  }

  return {
    name: repo,
    children: pageTreeChildren,
  };
}
