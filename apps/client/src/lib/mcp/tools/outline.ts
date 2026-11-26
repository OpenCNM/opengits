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

export function findDocInContext(ctx: RepoContext, path: string) {
  const norm = path.trim().toLowerCase();
  return ctx.repository.documents.find(
    (d: any) =>
      d.path.toLowerCase() === norm ||
      d.path.toLowerCase() === `${norm}.md` ||
      d.path.toLowerCase() === `${norm}.mdx`
  );
}

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
        // Prefer contentId for content-addressed chunks, falling back to documentId for legacy rows.
        where: doc.contentId ? { contentId: doc.contentId } : { documentId: doc.id },
        select: { heading: true, headingPath: true, contentType: true },
        orderBy: { id: 'asc' },
        take: 100,
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
