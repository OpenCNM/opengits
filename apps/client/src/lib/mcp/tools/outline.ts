/**
 * repo-tools outline 域：outline 结构感知原语（第一性原理）。
 * 职责：输出轻量化结构大纲（全仓导航树或单文档内部 TOC），
 * 严格控制体积（< 50 行），提供精确的 Address 定位锚点，
 * 绝不拉取海量 Chunk 撑爆 Agent 上下文。
 */
import { prisma } from '@/lib/db';
import { NavNode } from '@/engine/structurizer';
import { getEffectiveNavTree } from '@/lib/mcp/outline-projector';
import { buildSectionAddress, buildCleanSectionAddress } from '@/lib/mcp/section-address';
import {
  buildRepositoryConceptTaxonomy,
  formatConceptTaxonomyGrouped,
  CONCEPT_TAXONOMY_HEADER,
} from '@/lib/mcp/concept-graph';
import {
  RepoContext,
  RepoRuntime,
  resolveScopedTarget,
  refNotFoundError,
  scopeRequiredError,
  extractMacroTopologySection,
  fallbackWarning,
} from './shared';

/** 格式化目录树，带有最大条目上限保护（防止超大仓撑爆输出） */
export function formatNavTree(nodes?: NavNode[], indent = '', maxItems = 60): { text: string; count: number } {
  if (!nodes || !Array.isArray(nodes)) return { text: '', count: 0 };
  let result = '';
  let count = 0;

  function walk(currentNodes: NavNode[], currentIndent: string) {
    for (const node of currentNodes) {
      if (count >= maxItems) return;
      count++;
      if (node.type === 'directory') {
        result += `${currentIndent}📁 ${node.title}\n`;
        if (node.children && count < maxItems) {
          walk(node.children, currentIndent + '  ');
        }
      } else {
        result += `${currentIndent}📄 ${node.title} (${node.path})\n`;
      }
    }
  }

  walk(nodes, indent);
  if (count >= maxItems) {
    result += `${indent}... [More documents available; pass "path" to inspect specific document headings or use search]\n`;
  }
  return { text: result, count };
}

/** 路径容差查找：精确 / .md / .mdx 补全 / 大小写不敏感 */
export function findDocInContext(ctx: RepoContext, path: string) {
  const norm = path.trim().toLowerCase();
  return ctx.repository.documents.find(
    (d: any) =>
      d.path.toLowerCase() === norm ||
      d.path.toLowerCase() === `${norm}.md` ||
      d.path.toLowerCase() === `${norm}.mdx`
  );
}

/**
 * 概念拓扑清单单行格式化：概念名 (category) — 文档路径 [Address: ...]。
 */
function formatConceptTaxonomyLine(concept: {
  conceptName: string;
  category: string;
  path?: string | null;
  headingPath?: string | null;
}): string {
  const pathPart = concept.path ? ` — ${concept.path}` : '';
  const addressPart =
    concept.path && concept.headingPath
      ? ` [Address: ${buildCleanSectionAddress(concept.path, concept.headingPath)}]`
      : '';
  return `- ${concept.conceptName} (${concept.category})${pathPart}${addressPart}`;
}

export interface OutlineArgs {
  repository?: string;
  path?: string;
  depth?: number;
}

/**
 * 核心原语：runOutline
 * - 当未指定 path：返回仓库级概览导航树 + 顶级概念拓扑概览（轻量紧凑）
 * - 当指定 path：深入返回该单篇文档的章节级别 TOC 与定位 Address
 */
export async function runOutline(
  args: OutlineArgs,
  runtime: RepoRuntime,
  telemetryRepositoryId?: string
) {
  const startTime = Date.now();
  const ctx = await resolveScopedTarget(runtime, args.repository);
  const fbWarn = ctx ? fallbackWarning(ctx) : '';
  if (!ctx) {
    return args.repository ? refNotFoundError(args.repository, runtime) : scopeRequiredError(runtime);
  }

  const { path } = args;

  // ── 模式 1：单文档内部大纲深钻 (Drill-down mode) ──
  if (path) {
    const doc = findDocInContext(ctx, path);
    if (!doc) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Document not found: "${path}" in ${ctx.owner}/${ctx.repo}. Call outline without "path" to see available documents.`,
          },
        ],
        isError: true,
      };
    }

    const chunks = await prisma.documentChunk
      .findMany({
        // 内容寻址收官：新文档切片挂 contentId（documentId 维度已被停写清空），旧存量回落 documentId
        where: doc.contentId ? { contentId: doc.contentId } : { documentId: doc.id },
        select: { heading: true, headingPath: true, contentType: true },
        orderBy: { id: 'asc' },
        take: 100, // 足够涵盖单篇文档所有小节
      })
      .catch(() => []);

    let tocText = `📄 ${doc.title || doc.path}\nPath: ${doc.path}\n`;
    if (doc.summary) {
      tocText += `Summary: ${doc.summary}\n`;
    }
    tocText += `\n## Internal Headings (TOC)\n`;

    if (chunks.length === 0) {
      tocText += `(No internal heading chunks available. Use read with target="${doc.path}" to read the full page.)\n`;
    } else {
      const seenHeadings = new Set<string>();
      for (const chunk of chunks) {
        const heading = chunk.heading || '(Untitled Section)';
        const key = `${heading}::${chunk.headingPath || ''}`;
        if (seenHeadings.has(key)) continue;
        seenHeadings.add(key);

        const depth = chunk.headingPath ? chunk.headingPath.split(' > ').length - 1 : 0;
        const indent = '  '.repeat(depth);
        const typeLabel = chunk.contentType && chunk.contentType !== 'prose' ? ` [${chunk.contentType}]` : '';
        tocText += `${indent}- ${heading}${typeLabel} [Address: ${buildSectionAddress(doc.path, chunk.headingPath || heading)}]\n`;
      }
    }

    // 该文档关联的概念节点清单
    const docConcepts = await prisma.tutorialConceptNode
      .findMany({
        where: { repositoryId: ctx.repository.id, documentId: doc.id },
        select: { conceptName: true, category: true, headingPath: true },
        orderBy: { updatedAt: 'desc' },
        take: 20,
      })
      .catch(() => []);

    if (docConcepts.length > 0) {
      tocText += `\n## ${CONCEPT_TAXONOMY_HEADER}\n`;
      for (const concept of docConcepts) {
        tocText += `${formatConceptTaxonomyLine({ ...concept, path: doc.path })}\n`;
      }
    }

    tocText += `\n(Use read with target="${doc.path}" for the whole document, or target="<Address>" to read a specific section)`;

    

    return {
      telemetry: { dimension: 'documents', query: path, resultCount: chunks.length, resultSnapshot: { count: chunks.length } },
      content: [
        {
          type: 'text' as const,
          text: tocText,
        },
      ],
    };
  }

  // ── 模式 2：仓库级结构大纲 (Lightweight Repo Outline mode) ──
  let outlineText = '';
  const macroTopoSection = extractMacroTopologySection(ctx.repository.repoProfile);
  if (macroTopoSection) {
    outlineText += `${macroTopoSection}\n---\n\n`;
  }
  outlineText += `${fbWarn}Available Documentation in ${ctx.owner}/${ctx.repo}:\n\n`;
  const effectiveNavTree = await getEffectiveNavTree(ctx.repository.id, {
    owner: ctx.owner,
    repo: ctx.repo,
    fallbackNavTree: ctx.repository.navTree,
  });
  if (effectiveNavTree.length > 0) {
    const { text } = formatNavTree(effectiveNavTree, '', 60);
    outlineText += text;
  } else {
    const docs = ctx.repository.documents.slice(0, 60);
    for (const doc of docs) {
      outlineText += `- ${doc.title || doc.path} (${doc.path})\n`;
    }
    if (ctx.repository.documents.length > 60) {
      outlineText += `... [${ctx.repository.documents.length - 60} more documents; use search to find specific topics]\n`;
    }
  }

  // 注入顶级关键概念拓扑概览（限制条目，防打爆）
  const taxonomy = await buildRepositoryConceptTaxonomy(ctx.repository.id, 20).catch(() => []);
  if (taxonomy.length > 0) {
    outlineText += `\n---\n\n${formatConceptTaxonomyGrouped(taxonomy)}`;
  }

  if (macroTopoSection) {
    outlineText += `\n(Next steps: use explore_concept with action="architecture" to drill down into subsystem architecture diagrams, outline with "path" to inspect document headings, search to find keywords, or read with "target" to read content.)`;
  } else {
    outlineText += `\n(Next steps: use outline with "path" to inspect document headings, search to find keywords, or read with "target" to read content.)`;
  }

  

  return {
      telemetry: { dimension: 'documents', query: 'repo:outline', resultCount: ctx.repository.documents.length, resultSnapshot: { count: ctx.repository.documents.length } },
    content: [
      {
        type: 'text' as const,
        text: outlineText,
      },
    ],
  };
}
