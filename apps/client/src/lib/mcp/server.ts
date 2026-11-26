import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { deriveEditionLabel, isWebDocRepository, resolveRepositoryDisplayName } from '@/lib/repository-resolver';
import { NavNode } from '@/engine/structurizer';
import { getEffectiveNavTree } from '@/lib/mcp/outline-projector';
import {
  RepoRuntime,
  formatNavTree,
  registerRepositoryTools,
  capFullDocText,
  fetchDocumentContent,
} from '@/lib/mcp/repo-tools';
import { resolveRepositoryMcpCached } from '@/lib/mcp/repo-resolve-cache';
import { prisma } from '@/lib/db';
import { buildRepositoryConceptTaxonomy, formatConceptTaxonomyGrouped, CONCEPT_TAXONOMY_HEADER } from '@/lib/mcp/concept-graph';
import { parseSuperTopicsBlock } from '@/lib/mcp/graph-condense';
import { buildCleanSectionAddress } from '@/lib/mcp/section-address';
import { installUnknownToolFallback } from '@/lib/mcp/unknown-tool-fallback';
import { registerRepositoryPrompts } from '@/lib/mcp/repo-prompts';

import { MCP_MAX_TOOL_INPUT_ELEMENTS } from '@/lib/constants';

export async function createRepositoryMcpServer(
  owner: string,
  repo: string,
  versionOrBranch?: string,
  edition?: string,
  userId?: string | null
): Promise<McpServer | null> {
  const resolved = await resolveRepositoryMcpCached(owner, repo, versionOrBranch, edition, userId);

  if (!resolved || !resolved.repository) {
    return null;
  }

  const repository = resolved.repository;
  const targetVersionLabel = resolved.targetVersionLabel || resolved.resolvedBranch;

  const server = new McpServer({
    name: `opengits-${owner}-${repo}`,
    version: '1.0.0',
  }, { maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS });

server.registerResource(
    'overview',
    new ResourceTemplate(`docs://${owner}/${repo}/overview`, { list: undefined }),
    { title: `${owner}/${repo} Documentation Overview`, mimeType: 'text/markdown' },
    async (uri: URL) => {
      const isWeb = isWebDocRepository(repository);
      const displayName = resolveRepositoryDisplayName(repository);
      const lastSyncedAt = (repository.updatedAt || repository.createdAt).toISOString().slice(0, 10);
      const profile = (repository.repoProfile && typeof repository.repoProfile === 'object' ? repository.repoProfile : {}) as Record<string, unknown>;
      const sourceUrl = isWeb
        ? ((profile.originalUrl as string) || `https://${repository.repo.replace(/^web-docs-/, '')}`)
        : `https://github.com/${owner}/${repo}`;

      let overviewText = `# ${isWeb ? '🌐' : '🐙'} ${displayName} (${isWeb ? 'Web Docs' : 'GitHub'})\n\n`;
      overviewText += `Source: ${sourceUrl}\n`;
      overviewText += `Last Synced: ${lastSyncedAt}\n`;
      if (repository.category) {
        overviewText += `Category: ${repository.category}\n`;
      }
      overviewText += `\n`;
      
      overviewText += `## Structural Outline\n`;
      const effectiveNavTree = await getEffectiveNavTree(repository.id, {
        owner,
        repo,
        fallbackNavTree: repository.navTree,
      });
      if (effectiveNavTree.length > 0) {
        overviewText += formatNavTree(effectiveNavTree).text;
      } else {
        for (const doc of repository.documents) {
          overviewText += `- ${doc.title || doc.path} (${doc.path})\n`;
        }
      }

      overviewText += `\n## Document Summaries\n`;
      for (const doc of repository.documents) {
        if (doc.summary) {
          overviewText += `### ${doc.title || doc.path} (${doc.path})\n${doc.summary}\n\n`;
        }
      }

      return {
        contents: [
          {
            uri: uri.href,
            text: overviewText,
            mimeType: 'text/markdown',
          },
        ],
      };
    }
  );

  server.registerResource(
    'doc',
    new ResourceTemplate(`docs://${owner}/${repo}/doc/{path}`, { list: undefined }),
    { title: 'Document Content', mimeType: 'text/markdown' },
    async (uri: URL, { path }: any) => {
      const docPath = Array.isArray(path) ? path.join('/') : path;
      const doc = repository.documents.find(
        (d: any) => d.path.toLowerCase() === docPath.toLowerCase() ||
                    d.path.toLowerCase() === `${docPath.toLowerCase()}.md` ||
                    d.path.toLowerCase() === `${docPath.toLowerCase()}.mdx`
      );
      const docContent = doc ? await fetchDocumentContent(repository.id, doc.id, userId) : null;

      if (!doc || !docContent) {
        return {
          contents: [
            {
              uri: uri.href,
              text: `Document not found or currently unavailable: ${docPath}`,
              mimeType: 'text/plain',
            },
          ],
        };
      }

      return {
        contents: [
          {
            uri: uri.href,
            text: capFullDocText(docContent),
            mimeType: 'text/markdown',
          },
        ],
      };
    }
  );

  server.registerResource(
    'concepts',
    new ResourceTemplate(`concepts://${owner}/${repo}`, { list: undefined }),
    { title: `${owner}/${repo} Concept List`, mimeType: 'text/markdown' },
    async (uri: URL) => {
      const concepts = await prisma.tutorialConceptNode.findMany({
        where: { repositoryId: repository.id },
        select: { conceptName: true, category: true, slug: true, headingPath: true, document: { select: { path: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      });
      let text = `# ${owner}/${repo} Concepts (${concepts.length})\n\n`;
      if (concepts.length === 0) {
        text += `_No concepts extracted yet._\n`;
      } else {
        for (const c of concepts) {
          const addr = c.document?.path && c.headingPath ? buildCleanSectionAddress(c.document.path, c.headingPath) : null;
          text += `- ${c.conceptName} (${c.category})`;
          if (addr) text += ` [Address: ${addr}]`;
          text += `\n`;
        }
      }
      return { contents: [{ uri: uri.href, text, mimeType: 'text/markdown' }] };
    }
  );

  server.registerResource(
    'graph',
    new ResourceTemplate(`graph://${owner}/${repo}`, { list: undefined }),
    { title: `${owner}/${repo} Concept Graph`, mimeType: 'text/markdown' },
    async (uri: URL) => {
      const taxonomy = await buildRepositoryConceptTaxonomy(repository.id, 100);
      const edgeCount = await prisma.tutorialConceptEdge.count({ where: { repositoryId: repository.id } });
      const superTopics = parseSuperTopicsBlock(repository.repoProfile)?.topics ?? [];
      let text = `# ${owner}/${repo} Concept Graph\n`;
      text += `- 概念组: ${taxonomy.length}\n- 边数: ${edgeCount}\n`;
      if (superTopics.length > 0) {
        text += `- 超主题: ${superTopics.length}（${superTopics.map((t) => t.title).slice(0, 8).join(' / ')}）\n`;
      }
      text += `\n`;
      text += taxonomy.length > 0 ? formatConceptTaxonomyGrouped(taxonomy) : `## ${CONCEPT_TAXONOMY_HEADER}\n\n_图谱边尚未构建。_\n`;
      return { contents: [{ uri: uri.href, text, mimeType: 'text/markdown' }] };
    }
  );

const runtime: RepoRuntime = {
    label: `${owner}/${repo}`,
    multiRepo: false,
    userId: userId ?? undefined,
    resolveRepository: async () => ({
      owner,
      repo,
      repository,
      targetVersionLabel,
      edition: repository.edition ?? '',
      editionLabel:
        repository.edition && repository.edition !== ''
          ? deriveEditionLabel(repository.repoProfile)
          : undefined,
      // Fail-loud: surface fallback warning when requested edition/version missed and fell back to base.
      isFallback: resolved.isFallback,
      requestedEdition: edition || versionOrBranch || undefined,
    }),
    listRepositories: async () => [],
  };

  await registerRepositoryTools(server, runtime);

  await registerRepositoryPrompts(server, runtime);

  // Install after all tools are registered so the snapshot includes every tool name.
  installUnknownToolFallback(server, { label: `${owner}/${repo}` });

  return server;
}
