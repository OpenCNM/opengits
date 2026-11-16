import { NextRequest, NextResponse } from 'next/server';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { getCorsHeaders } from '@/lib/constants';
import { repositoryMcpHandler } from '@/lib/mcp/handler-factory';
import { cachedDefaultBranchRepository, resolveRepositoryMcpCached } from '@/lib/mcp/repo-resolve-cache';
import { recordMcpClientPresence } from '@/lib/mcp/mcp-heartbeat';
import { runWithMcpClientContext, runWithMcpEditionContext } from '@/lib/telemetry/mcp-beacon';
import { enforceMcpAuth, enforceMcpAuthAndQuota } from '@/lib/mcp/request-guard';
import { MCP_AVAILABLE_TOOLS } from '@/lib/mcp/capability-manifest';
import { normalizeMcpToolCallRequest } from '@/lib/mcp/request-normalizer';

function corsHeaders() {
  return getCorsHeaders('GET, POST, OPTIONS');
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ owner: string; repo: string }> }
) {
  try {
    const { owner, repo } = await params;
    // MCP 必须登录（产品规则：未登录仅可浏览公开教程）；支持 Bearer API Token 与 Web 会话双通道
    const guard = await enforceMcpAuth(request, { cors: corsHeaders() });
    if (guard.response) return guard.response;

    const repository = await cachedDefaultBranchRepository(owner, repo);

    if (!repository) {
      return NextResponse.json({ error: 'Repository not found' }, { status: 404, headers: corsHeaders() });
    }

    if (repository.mcpStatus === 'PAUSED') {
      return NextResponse.json(
        { error: 'MCP service for this repository is currently paused by administrator' },
        { status: 503, headers: corsHeaders() }
      );
    }

    // 私有仓元数据不外泄：非公开且无访问权时按不存在处理（404），与 POST 的 403 区分——
    // GET 是发现面（浏览器/爬虫），只确认存在性即构成信息泄露
    const isAuthorized = await verifyRepoAccessDirect(repository, guard.userId);
    if (!repository.isPublic && !isAuthorized) {
      return NextResponse.json({ error: 'Repository not found' }, { status: 404, headers: corsHeaders() });
    }

    // 尝试交由核心 Handler 处理标准的 MCP 请求与扩展
    const res = await repositoryMcpHandler.fetch(request, {
      authInfo: guard.userId ? { token: guard.userId, clientId: guard.userId, scopes: [], extra: {} } : undefined,
    });
    if (res.status !== 404 && res.status !== 405) {
      return res;
    }

    // 元数据描述保底响应
    return NextResponse.json(
      {
        name: `opengits-${owner}-${repo}`,
        version: '1.0.0',
        description: `MCP Server and Knowledge Hub for ${owner}/${repo}`,
        status: 'READY',
        endpoints: {
          rpc: `/api/mcp/${owner}/${repo}`,
          llmsTxt: `/api/llms-txt/${owner}/${repo}`,
        },
        capabilities: {
          // 与 registerRepositoryTools 实际注册的 6 工具一致（MCP_AVAILABLE_TOOLS）
          tools: MCP_AVAILABLE_TOOLS,
          resources: [`docs://${owner}/${repo}/overview`, `docs://${owner}/${repo}/doc/{path}`, `concepts://${owner}/${repo}`, `graph://${owner}/${repo}`],
        },
      },
      { status: 200, headers: corsHeaders() }
    );
  } catch (error) {
    console.error('Error in GET /api/mcp:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500, headers: corsHeaders() });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ owner: string; repo: string }> }
) {
  try {
    const { owner, repo } = await params;
    // 鉴权 + 配额统一守卫（Bearer token / session 双通道 → 封禁 / RPM / 每日配额）
    const guard = await enforceMcpAuthAndQuota(request, { rpc: true, cors: corsHeaders() });
    if (guard.response) return guard.response;
    const userId = guard.userId;

    // Heartbeat tracking + 即时 presence 事件（Dashboard MCP 客户端面板数据源）
    const clientHeader = request.headers.get('x-mcp-client-name') || request.headers.get('user-agent') || 'Unknown Client';
    const clientName = recordMcpClientPresence(
      userId,
      clientHeader,
      request.headers.get('x-forwarded-for')?.split(',')[0] || undefined,
    );

    const repository = await cachedDefaultBranchRepository(owner, repo);

    if (!repository) {
      return NextResponse.json(
        { jsonrpc: '2.0', error: { code: -32000, message: 'Repository not found' }, id: null },
        { status: 404, headers: corsHeaders() }
      );
    }

    if (repository.mcpStatus === 'PAUSED') {
      return NextResponse.json(
        { jsonrpc: '2.0', error: { code: -32000, message: 'MCP service for this repository is currently paused by administrator' }, id: null },
        { status: 503, headers: corsHeaders() }
      );
    }

    const isAuthorized = await verifyRepoAccessDirect(repository, userId);
    if (!repository.isPublic && !isAuthorized) {
      return NextResponse.json(
        { jsonrpc: '2.0', error: { code: -32001, message: 'Forbidden: Repository is private' }, id: null },
        { status: 403, headers: corsHeaders() }
      );
    }

    // 网关层请求规范化（别名透明重写与未知工具短路响应，零 monkey patch）
    const normalized = await normalizeMcpToolCallRequest(
      request,
      MCP_AVAILABLE_TOOLS,
      `${owner}/${repo}`
    );
    if (normalized.directResponse) {
      return normalized.directResponse;
    }

    // 讲法/版本回退观测：?edition= 未命中回退基础行时，遥测自动携带 requested/resolved/isFallback
    // （与 server.ts RepoContext.isFallback 同源；resolveRepositoryMcpCached 60s TTL 热缓存）
    const requestedEdition = new URL(request.url).searchParams.get('edition') || undefined;
    let editionContext: { requestedEdition?: string; resolvedEdition?: string; isFallback?: boolean } | undefined;
    if (requestedEdition) {
      const resolved = await resolveRepositoryMcpCached(owner, repo, undefined, requestedEdition, userId);
      if (resolved?.repository) {
        editionContext = {
          requestedEdition,
          resolvedEdition: resolved.resolvedEdition ?? '',
          isFallback: resolved.isFallback,
        };
      }
    }

    // 委派给 Web Standard HTTP MCP Handler 集中处理 (支持 Stateless 交互)；
    // 客户端名注入遥测上下文（handler 为模块级单例，请求级数据只能经 AsyncLocalStorage 透传）
    return await runWithMcpClientContext(clientName, () =>
      runWithMcpEditionContext(editionContext, () =>
        repositoryMcpHandler.fetch(normalized.request, {
          authInfo: userId ? { token: userId, clientId: userId, scopes: [], extra: {} } : undefined,
        }),
      ),
    );
  } catch (error: any) {
    console.error('Error handling JSON-RPC POST in /api/mcp:', error);
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32603, message: 'Internal Server Error' }, id: null },
      { status: 500, headers: corsHeaders() }
    );
  }
}
