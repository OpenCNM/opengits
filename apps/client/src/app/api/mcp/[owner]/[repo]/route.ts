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

    const isAuthorized = await verifyRepoAccessDirect(repository, guard.userId);
    if (!repository.isPublic && !isAuthorized) {
      return NextResponse.json({ error: 'Repository not found' }, { status: 404, headers: corsHeaders() });
    }

    const res = await repositoryMcpHandler.fetch(request, {
      authInfo: guard.userId ? { token: guard.userId, clientId: guard.userId, scopes: [], extra: {} } : undefined,
    });
    if (res.status !== 404 && res.status !== 405) {
      return res;
    }

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
    const guard = await enforceMcpAuthAndQuota(request, { rpc: true, cors: corsHeaders() });
    if (guard.response) return guard.response;
    const userId = guard.userId;

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

    const normalized = await normalizeMcpToolCallRequest(
      request,
      MCP_AVAILABLE_TOOLS,
      `${owner}/${repo}`
    );
    if (normalized.directResponse) {
      return normalized.directResponse;
    }

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
