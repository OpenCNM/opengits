import { NextResponse } from 'next/server';

/**
 * RFC 9728 受保护资源元数据（MCP 2026-07-28 授权框架的发现入口）：
 * MCP 客户端在收到 401 的 WWW-Authenticate resource_metadata 指引后，
 * 经本端点定位授权服务器（authorization_servers），再走 RFC 8414 取 AS 元数据。
 * resource 语义：本服务同源下的全部 MCP 端点（单租户单 AS，与 authorize 的
 * RFC 8707 合法集同口径）。
 */
export async function GET() {
  const issuer = process.env.NEXTAUTH_URL || 'http://localhost:3000';
  return NextResponse.json(
    {
      resource: issuer,
      authorization_servers: [issuer],
      scopes_supported: ['mcp'],
      // 本 RS 的 Bearer 挑战经 WWW-Authenticate 下发（request-guard 401）
      bearer_methods_supported: ['header'],
    },
    { headers: { 'Cache-Control': 'public, max-age=3600' } }
  );
}
