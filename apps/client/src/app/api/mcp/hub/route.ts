import { NextRequest, NextResponse } from 'next/server';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { prisma } from '@/lib/db';
import { getCorsHeaders } from '@/lib/constants';
import { buildBookshelfManifest, MCP_AVAILABLE_TOOLS } from '@/lib/mcp/capability-manifest';
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

/**
 * Hub 模式的仓库解析运行时：供共享工具工厂（registerRepositoryTools）使用。
 * - resolveRepository(ref)：仅允许解析当前用户书架（savedRepositories）内的仓库，
 *   支持 "owner/repo"、"owner/repo@edition"、仓库 ID 三种引用形式；
 *   admin 暂停（mcpStatus=PAUSED）的仓按未找到处理。
 * - listRepositories()：返回折叠后的主讲法行（同仓库多讲法只保留「最近在读 > 基础行」，
 *   防止同一知识点多份叙述挤占 fan-out 配额；@edition 引用仍可精确直达任意讲法），
 *   并排除 admin 暂停的仓。
 */
async function createHubRepoRuntime(userId: string): Promise<RepoRuntime> {
  const toContext = async (saved: {
    owner: string;
    repo: string;
    edition?: string | null;
    siblingCount?: number;
  }): Promise<RepoContext | null> => {
    // 热路径缓存（与单仓 server.ts 同一缓存实例）：Hub fan-out 每仓解析也走 60s TTL 缓存
    const resolved = await resolveRepositoryMcpCached(saved.owner, saved.repo, undefined, saved.edition || undefined, userId);
    if (!resolved?.repository) return null;
    // 显式 @edition 未命中时宁可报「未找到」也不静默回退基础行（Agent 的讲法意图必须被尊重）
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
      // 版本维度回退（isFallback）透传：讲法维度回退已被上方守卫转为「未找到」
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

      // 确定性取行：无 @edition 引用时同组多行（基础行+讲法行）按 edition 字典序稳定取基础行
      const rows = [...(user?.savedRepos || [])].sort((a, b) =>
        (a.repository.edition ?? '').localeCompare(b.repository.edition ?? '')
      );
      const saved = rows[0]?.repository;
      if (!saved) return null;
      if (user?.disabledMcpRepoIds?.includes(saved.id)) return null;
      // admin 暂停的仓在 Hub 侧同样按未找到处理（与单仓路由的 PAUSED 503 语义收敛）
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

      // 讲法折叠：同 (owner, repo, branch) 组只保留主讲法行（最近在读 > 基础行 > edition 字典序）
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

async function createHubServer(userId: string) {
  const server = new McpServer({
    name: 'opengits-user-hub',
    version: '1.0.0',
  }, { maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS });

  // ── Resource: hub://overview ──
  server.registerResource(
    'hub_overview',
    'hub://overview',
    { title: 'OpenGits Hub Overview', mimeType: 'text/markdown' },
    async () => {
      const manifests = await buildBookshelfManifest(userId);
      let text = `# OpenGits Hub Capability Manifest Overview\n\n`;
      text += `Total Tutorials on Hub: ${manifests.length}\n\n`;

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

  // ── 共享工厂注册全部核心工具（清单与 MCP_AVAILABLE_TOOLS 锁步）──
  const hubRuntime = await createHubRepoRuntime(userId);
  await registerRepositoryTools(server, hubRuntime);

  // 标准 Prompts：/ 唤起多步工作流（repository 可选，跨库检索）
  await registerRepositoryPrompts(server, hubRuntime);

  // 未知工具兜底：LLM 幻觉调用不存在的工具名时返回 did-you-mean 建议（须在全部注册之后）
  installUnknownToolFallback(server, { label: 'your OpenGits Hub' });

  return server;
}

// 浏览器跨域预检：与单仓/bundle 路由同口径（缺 OPTIONS 时预检 405 且无 CORS 头）
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders('GET, POST, OPTIONS'),
  });
}

export async function GET(req: NextRequest) {
  try {
    // 强制鉴权（历史：无凭证回落默认书架用户——匿名游客可代默认用户执行全部工具，已移除）
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
        tools: [
          'list_resources',
          'search',
          'read_document',
          'explore_concept',
          'check_breaking_changes',
        ],
      },
      { status: 200, headers: getCorsHeaders() }
    );
  } catch (error: any) {
    console.error('Error in GET /api/mcp/hub:', error);
    // 面向公网客户端只回通用文案（内部错误 message 可能携带表名/连接细节）
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500, headers: getCorsHeaders() }
    );
  }
}

// 模块级单例 handler（性能：原每请求 createMcpHandler + 工厂重建 + 安装兜底）；
// userId 经 fetch options.authInfo.token 透传（与单仓路由同款模式）
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
    // 强制鉴权 + 配额（历史：无凭证回落默认书架用户且零配额检查，已收敛到统一守卫）
    const guard = await enforceMcpAuthAndQuota(req, { rpc: true, cors: getCorsHeaders() });
    if (guard.response) return guard.response;
    const userId = guard.userId;

    // Heartbeat tracking（与单仓路由同款：Dashboard MCP 客户端面板数据源）+ 即时 presence 事件
    const clientHeader = req.headers.get('x-mcp-client-name') || req.headers.get('user-agent') || 'Unknown Client';
    const clientName = recordMcpClientPresence(
      userId,
      clientHeader,
      req.headers.get('x-forwarded-for')?.split(',')[0] || undefined,
    );

    // 网关层请求规范化（别名透明重写与未知工具短路响应，零 monkey patch）
    const normalized = await normalizeMcpToolCallRequest(
      req,
      MCP_AVAILABLE_TOOLS,
      'your OpenGits Hub'
    );
    if (normalized.directResponse) {
      return normalized.directResponse;
    }

    // 客户端名注入遥测上下文：工具调用落 McpCallLog.clientName + call 事件
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
