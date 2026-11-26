import { NextRequest, NextResponse } from 'next/server';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { prisma } from '@/lib/db';
import { getCorsHeaders } from '@/lib/constants';
import {
  buildBookshelfManifest,
  MCP_AVAILABLE_TOOLS,
  type TutorialCapabilityManifest,
} from '@/lib/mcp/capability-manifest';
import { deriveEditionLabel } from '@/lib/repository-resolver';
import { parseHubRef, foldScopeRows, fetchReadingActivity } from '@/lib/mcp/edition-scope';
import { resolveRepositoryMcpCached } from '@/lib/mcp/repo-resolve-cache';
import { recordMcpClientPresence } from '@/lib/mcp/mcp-heartbeat';
import { runWithMcpClientContext } from '@/lib/telemetry/mcp-beacon';
import { normalizeMcpToolCallRequest } from '@/lib/mcp/request-normalizer';
import {
  RepoContext,
  RepoRuntime,
  registerRepositoryTools,
} from '@/lib/mcp/repo-tools';
import { installUnknownToolFallback } from '@/lib/mcp/unknown-tool-fallback';
import { registerRepositoryPrompts } from '@/lib/mcp/repo-prompts';
import { enforceMcpAuth, enforceMcpAuthAndQuota } from '@/lib/mcp/request-guard';
import { MCP_MAX_TOOL_INPUT_ELEMENTS } from '@/lib/constants';

async function createHubRepoRuntime(userId: string): Promise<RepoRuntime> {
  const toContext = async (saved: {
    owner: string;
    repo: string;
    edition?: string | null;
    siblingCount?: number;
  }): Promise<RepoContext | null> => {
    const resolved = await resolveRepositoryMcpCached(saved.owner, saved.repo, undefined, saved.edition || undefined, userId);
    if (!resolved?.repository) return null;
    if (saved.edition && resolved.resolvedEdition !== saved.edition) return null;
    return {
      owner: resolved.repository.owner,
      repo: resolved.repository.repo,
      repository: resolved.repository,
      targetVersionLabel: resolved.targetVersionLabel,
      edition: resolved.repository.edition ?? '',
      editionLabel:
        resolved.repository.edition && resolved.repository.edition !== ''
          ? deriveEditionLabel(resolved.repository.repoProfile)
          : undefined,
      editionSiblingCount: saved.siblingCount ?? 0,
      isFallback: resolved.isFallback,
      requestedEdition: saved.edition || undefined,
    };
  };

  return {
    label: 'your OpenGits Hub',
    multiRepo: true,
    userId,
    resolveRepository: async (ref) => {
      if (!ref) return null;
      const { base, edition } = parseHubRef(ref);
      const parts = base.split('/');
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          disabledMcpRepoIds: true,
          savedRepos: {
            select: { repository: { select: { id: true, owner: true, repo: true, edition: true, mcpStatus: true } } },
            where: {
              OR: [
                { repository: { id: base, ...(edition !== null ? { edition } : {}) } },
                {
                  repository: {
                    owner: { equals: parts[0] || '', mode: 'insensitive' },
                    repo: { equals: parts[1] || '', mode: 'insensitive' },
                    ...(edition !== null ? { edition } : {}),
                  },
                },
              ],
            },
          },
        },
      });

      const rows = [...(user?.savedRepos || [])].sort((a, b) =>
        (a.repository.edition ?? '').localeCompare(b.repository.edition ?? '')
      );
      const saved = rows[0]?.repository;
      if (!saved) return null;
      if (user?.disabledMcpRepoIds?.includes(saved.id)) return null;
      if (saved.mcpStatus === 'PAUSED') return null;
      return toContext(saved);
    },
    listRepositories: async () => {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          disabledMcpRepoIds: true,
          savedRepos: { select: { repository: { select: { id: true, owner: true, repo: true, branch: true, edition: true, mcpStatus: true } } } }
        },
      });
      const disabledSet = new Set(user?.disabledMcpRepoIds || []);
      const activeRows = (user?.savedRepos || [])
        .map((sr) => sr.repository)
        .filter((s) => !disabledSet.has(s.id))
        .filter((s) => s.mcpStatus !== 'PAUSED');

      const activity = await fetchReadingActivity(userId, activeRows.map(r => r.id));
      const groups = foldScopeRows(activeRows, activity);
      const results = await Promise.allSettled(
        groups.map(async (g) =>
          toContext({ ...g.preferred, siblingCount: g.rows.length - 1 })
        )
      );
      return results
        .filter((r): r is PromiseFulfilledResult<RepoContext | null> => r.status === 'fulfilled')
        .map((r) => r.value)
        .filter((v): v is RepoContext => v !== null);
    },
  };
}

const HUB_OVERVIEW_FULL_MAX_REPOS = 15;
const HUB_OVERVIEW_COMPACT_MAX_REPOS = 80;
const HUB_OVERVIEW_ACTIVE_SUMMARY_LIMIT = 20;

function formatCompactManifestLine(m: TutorialCapabilityManifest): string {
  const isWeb = m.identity.sourceType === 'web';
  const icon = isWeb ? '🌐' : '🐙';
  const version = m.identity.version || 'main';
  const tech = m.techStack?.primaryLanguages?.length
    ? ` | ${m.techStack.primaryLanguages.join(', ')}${m.techStack.framework ? ` (${m.techStack.framework})` : ''}`
    : '';
  const summary = m.bestUsedFor?.[0] ? ` | ${m.bestUsedFor[0].slice(0, 100)}` : '';
  return `- ${icon} **${m.identity.displayName}** (\`${m.identity.owner}/${m.identity.repo}\`) | ${version}${tech}${summary}\n`;
}

async function createHubServer(userId: string) {
  const server = new McpServer({
    name: 'opengits-user-hub',
    version: '1.0.0',
  }, { maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS });

  server.registerResource(
    'hub_overview',
    'hub://overview',
    { title: 'OpenGits Hub Overview', mimeType: 'text/markdown' },
    async () => {
      const manifests = await buildBookshelfManifest(userId);
      let text = `# OpenGits Hub Capability Manifest Overview\n\n`;
      text += `Total Tutorials on Hub: ${manifests.length}\n\n`;

      if (manifests.length <= HUB_OVERVIEW_FULL_MAX_REPOS) {
        for (let i = 0; i < manifests.length; i++) {
          const m = manifests[i];
          const isWeb = m.identity.sourceType === 'web';
          text += `## ${i + 1}. ${isWeb ? '🌐' : '🐙'} ${m.identity.displayName} (${isWeb ? 'Web Docs' : 'GitHub'} | ${m.contentProfile.ingestMode})\n`;
          text += `Category: ${m.identity.category || 'General'} | Version: ${m.identity.version || 'main'}\n`;
          text += `Source: ${m.identity.sourceUrl} | Last Synced: ${m.identity.lastSyncedAt}\n`;
          if (m.techStack) {
            text += `Tech Stack: ${m.techStack.primaryLanguages.join(', ')} (${m.techStack.framework || 'No framework'})\n`;
          }
          text += `\n**Best Used For:**\n`;
          for (const point of m.bestUsedFor) {
            text += `- ${point}\n`;
          }
          text += `\n**Teaching Chapters (${m.teachingCapabilities.chapters.length} chapters):**\n`;
          for (const ch of m.teachingCapabilities.chapters.slice(0, 8)) {
            text += `  - **${ch.title}**: ${ch.summary}\n`;
          }
          text += `\n---\n\n`;
        }
      } else {
        const byCat = new Map<string, TutorialCapabilityManifest[]>();
        for (const m of manifests) {
          const cat = (m.identity.category || '').trim() || 'General';
          const list = byCat.get(cat) ?? [];
          list.push(m);
          byCat.set(cat, list);
        }
        const sortedCats = Array.from(byCat.keys()).sort();

        if (manifests.length <= HUB_OVERVIEW_COMPACT_MAX_REPOS) {
          for (const cat of sortedCats) {
            const list = byCat.get(cat)!;
            text += `## ${cat} (${list.length})\n`;
            for (const m of list) {
              text += formatCompactManifestLine(m);
            }
            text += '\n';
          }
          text += `(Compact mode: chapters omitted to stay within context budget. Pass repository="owner/repo" to browse or search(query=...) to drill down.)`;
        } else {
          text += `## Categories\n`;
          for (const cat of sortedCats) {
            text += `- **${cat}**: ${byCat.get(cat)!.length} tutorials\n`;
          }
          const active = [...manifests]
            .sort((a, b) => (b.identity.lastSyncedAt || '').localeCompare(a.identity.lastSyncedAt || ''))
            .slice(0, HUB_OVERVIEW_ACTIVE_SUMMARY_LIMIT);
          text += `\n## Recently Active Tutorials (Top ${HUB_OVERVIEW_ACTIVE_SUMMARY_LIMIT})\n`;
          for (const m of active) {
            text += formatCompactManifestLine(m);
          }
          text += `\nYour Hub has ${manifests.length} tutorials. Use search(query=...) to find relevant tutorials and sections directly, or browse(category=..., query=...) to filter by domain.`;
        }
      }

      return {
        contents: [
          {
            uri: 'hub://overview',
            text,
            mimeType: 'text/markdown',
          },
        ],
      };
    }
  );

  const hubRuntime = await createHubRepoRuntime(userId);
  await registerRepositoryTools(server, hubRuntime);

  await registerRepositoryPrompts(server, hubRuntime);

  installUnknownToolFallback(server, { label: 'your OpenGits Hub' });

  return server;
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders('GET, POST, OPTIONS'),
  });
}

export async function GET(req: NextRequest) {
  try {
    const guard = await enforceMcpAuth(req, { cors: getCorsHeaders() });
    if (guard.response) return guard.response;
    const userId = guard.userId;

    const manifests = await buildBookshelfManifest(userId);

    return NextResponse.json(
      {
        name: 'opengits-user-hub',
        version: '1.0.0',
        description: `Unified OpenGits Hub MCP. Contains ${manifests.length} tutorials with full Capability Manifests plus high-leverage engineering tools (see tools/list) searchable per-tutorial or across the whole Hub.`,
        tutorialsCount: manifests.length,
        manifests,
        rpc: '/api/mcp/hub',
        tools: [...MCP_AVAILABLE_TOOLS],
      },
      { status: 200, headers: getCorsHeaders() }
    );
  } catch (error: any) {
    console.error('Error in GET /api/mcp/hub:', error);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500, headers: getCorsHeaders() }
    );
  }
}

const hubMcpHandler = createMcpHandler(
  async (ctx) => {
    const userId = typeof (ctx.authInfo as { token?: unknown } | undefined)?.token === 'string'
      ? (ctx.authInfo as { token: string }).token
      : '';
    const server = await createHubServer(userId);
    if (!server) throw new Error('Hub server unavailable');
    return server;
  },
  { legacy: 'stateless', keepAliveMs: 15000 }
);

export async function POST(req: NextRequest) {
  try {
    const guard = await enforceMcpAuthAndQuota(req, { rpc: true, cors: getCorsHeaders() });
    if (guard.response) return guard.response;
    const userId = guard.userId;

    const clientHeader = req.headers.get('x-mcp-client-name') || req.headers.get('user-agent') || 'Unknown Client';
    const clientName = recordMcpClientPresence(
      userId,
      clientHeader,
      req.headers.get('x-forwarded-for')?.split(',')[0] || undefined,
    );

    const normalized = await normalizeMcpToolCallRequest(
      req,
      MCP_AVAILABLE_TOOLS,
      'your OpenGits Hub'
    );
    if (normalized.directResponse) {
      return normalized.directResponse;
    }

    return await runWithMcpClientContext(clientName, () =>
      hubMcpHandler.fetch(normalized.request, {
        authInfo: { token: userId, clientId: userId, scopes: [], extra: {} },
      })
    );
  } catch (error: any) {
    console.error('Error handling JSON-RPC in /api/mcp/hub:', error);
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32603, message: 'Internal Server Error' }, id: null },
      { status: 500, headers: getCorsHeaders() }
    );
  }
}
