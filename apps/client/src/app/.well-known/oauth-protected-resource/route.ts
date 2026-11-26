import { NextResponse } from 'next/server';

export async function GET() {
  const issuer = process.env.NEXTAUTH_URL || 'http://localhost:3000';
  return NextResponse.json(
    {
      resource: issuer,
      authorization_servers: [issuer],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
    },
    { headers: { 'Cache-Control': 'public, max-age=3600' } }
  );
}
