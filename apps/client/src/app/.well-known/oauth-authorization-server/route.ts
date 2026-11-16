import { NextResponse } from 'next/server';

/**
 * RFC 8414 授权服务器元数据（MCP 规范要求的发现端点）。
 * 签发的 access_token 即现有 McpApiToken（Bearer 全链路复用 request-guard 的鉴权/配额）。
 */
export async function GET() {
  const issuer = process.env.NEXTAUTH_URL || 'http://localhost:3000';
  return NextResponse.json(
    {
      issuer,
      authorization_endpoint: `${issuer}/api/auth/oauth/authorize`,
      token_endpoint: `${issuer}/api/auth/oauth/token`,
      registration_endpoint: `${issuer}/api/auth/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported: ['mcp'],
    },
    { headers: { 'Cache-Control': 'public, max-age=3600' } }
  );
}
