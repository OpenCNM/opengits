import { createMcpHandler } from '@modelcontextprotocol/server';
import { createRepositoryMcpServer } from '@/lib/mcp/server';

export const repositoryMcpHandler = createMcpHandler(
  async (ctx) => {
    const url = new URL(ctx.requestInfo?.url || 'http://localhost');
    const pathnameParts = url.pathname.split('/').filter(Boolean);
    
    let owner = '';
    let repo = '';

    const mcpIndex = pathnameParts.indexOf('mcp');
    if (mcpIndex !== -1 && pathnameParts.length >= mcpIndex + 3) {
      owner = pathnameParts[mcpIndex + 1];
      repo = pathnameParts[mcpIndex + 2];
    }

    if (!owner || !repo) {
      throw new Error('Invalid MCP Repository URL parameters');
    }

    const edition = url.searchParams.get('edition') || undefined;

    const server = await createRepositoryMcpServer(
      owner,
      repo,
      undefined,
      edition,
      // Route passes userId via authInfo.token to scope private doc preloads; unauthenticated calls see shared docs only.
      typeof (ctx.authInfo as { token?: unknown } | undefined)?.token === 'string'
        ? (ctx.authInfo as { token: string }).token
        : null
    );
    if (!server) {
      throw new Error(`Repository ${owner}/${repo} not found`);
    }

    return server;
  },
  {
    legacy: 'stateless',
    keepAliveMs: 15000,
  }
);
