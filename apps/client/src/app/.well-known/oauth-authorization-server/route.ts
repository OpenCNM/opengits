import { NextResponse } from 'next/server';

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
