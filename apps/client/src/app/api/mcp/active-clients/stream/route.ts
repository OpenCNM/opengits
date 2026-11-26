import { NextRequest } from 'next/server';
import { getSessionHelper } from '@/lib/auth-helper';
import { forwardSse } from '@/lib/sse/sse-gateway-driver';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSessionHelper();
  if (!session?.user?.id) {
    const encoder = new TextEncoder();
    const body = `data: ${JSON.stringify({ clients: [], unauthenticated: true })}\n\n`;
    return new Response(encoder.encode(body), {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  }

  return forwardSse(req, '/api/mcp/active-clients/stream', { userId: session.user.id });
}
