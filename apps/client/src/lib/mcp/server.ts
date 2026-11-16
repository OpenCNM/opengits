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


/**
 * 创建单仓库 MCP Server。
 *
 * 全部 MCP 工具的实现已抽离至 src/lib/mcp/repo-tools.ts 共享工厂
 * （与 OpenGits Hub 复用同一套逻辑），此处仅负责：
 * 1. 解析目标仓库上下文（元数据预载，正文按需懒加载——见 repositoryDocsInclude）
 * 2. 注册 2 个文档资源（docs://{owner}/{repo}/overview 与 doc/{path}）
 *    及 concepts:// 与 graph:// 资源
 * 3. 以单仓 RepoRuntime 调用共享工厂注册全部工具（数量与 MCP_AVAILABLE_TOOLS 一致）
 */
export async function createRepositoryMcpServer(
  owner: string,
  repo: string,
  versionOrBranch?: string,
  edition?: string,
  userId?: string | null
): Promise<McpServer | null> {
  // 热路径缓存：同一 Agent 会话连续请求同仓时跳过重复的 resolveRepository 重查询
  // （staleness ≤ MCP_HOT_CACHE_TTL_MS；含 null 未命中缓存，挡扫描型 miss）
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

  // -------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------

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

  // ── 资源：concepts://{owner}/{repo} — 该仓概念清单（名/category/Address）──
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

  // ── 资源：graph://{owner}/{repo} — 该仓概念图 markdown 视图（分类分组拓扑 + 边规模）──
  server.registerResource(
    'graph',
    new ResourceTemplate(`graph://${owner}/${repo}`, { list: undefined }),
    { title: `${owner}/${repo} Concept Graph`, mimeType: 'text/markdown' },
    async (uri: URL) => {
      const taxonomy = await buildRepositoryConceptTaxonomy(repository.id, 100);
      const edgeCount = await prisma.tutorialConceptEdge.count({ where: { repositoryId: repository.id } });
      // L2 超主题概览（巨仓「目录的目录」；未凝聚的仓为空，零成本跳过）
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

  // -------------------------------------------------------------
  // Tools (via shared factory, single-repo mode)
  // -------------------------------------------------------------

  const runtime: RepoRuntime = {
    label: `${owner}/${repo}`,
    multiRepo: false,
    userId: userId ?? undefined,
    resolveRepository: async () => ({
      owner,
      repo,
      repository,
      targetVersionLabel,
      // 端点 URL ?edition= 钉死的讲法行：归因（讲法: label）与折叠提示消费
      edition: repository.edition ?? '',
      editionLabel:
        repository.edition && repository.edition !== ''
          ? deriveEditionLabel(repository.repoProfile)
          : undefined,
      // fail-loud：显式请求的讲法/版本未命中回退基础行时，工具输出注入警告（区别于静默降级）
      isFallback: resolved.isFallback,
      requestedEdition: edition || versionOrBranch || undefined,
    }),
    listRepositories: async () => [],
  };

  await registerRepositoryTools(server, runtime);

  // 标准 Prompts：/ 唤起多步工作流（explain-architecture / audit-breaking-changes）
  await registerRepositoryPrompts(server, runtime);

  // 未知工具兜底：LLM 幻觉调用不存在的工具名时返回 did-you-mean 建议（须在全部注册之后）
  installUnknownToolFallback(server, { label: `${owner}/${repo}` });

  return server;
}
