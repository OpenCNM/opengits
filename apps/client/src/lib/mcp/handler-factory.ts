import { createMcpHandler } from '@modelcontextprotocol/server';
import { createRepositoryMcpServer } from '@/lib/mcp/server';

/**
 * 统一的核心基于 v2 规范的 HTTP MCP Web Standard Handler 实例。
 * 兼容按请求无状态模式 (Stateless) 与 旧版 2025 客户端回退。
 */
export const repositoryMcpHandler = createMcpHandler(
  async (ctx) => {
    const url = new URL(ctx.requestInfo?.url || 'http://localhost');
    const pathnameParts = url.pathname.split('/').filter(Boolean);
    
    // 解析 URL 路径格式，提取 /api/mcp/[owner]/[repo] 中的 owner 与 repo
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

    // 讲法维度：端点 URL 携带 ?edition= 时钉死讲法行（客户端在 MCP 配置里加查询参数即可切换讲法）
    const edition = url.searchParams.get('edition') || undefined;

    const server = await createRepositoryMcpServer(
      owner,
      repo,
      undefined,
      edition,
      // 真冻结：路由层把 userId 作为 authInfo.token 透传（见 /api/mcp/[owner]/[repo]），
      // 文档预载只加载"该用户副本 + 共享文档"；无 authInfo（游客/模拟）仅共享文档
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
    legacy: 'stateless', // 保持与旧版 2025 MCP 客户端兼容
    keepAliveMs: 15000,
  }
);
