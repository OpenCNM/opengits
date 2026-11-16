import { NextRequest } from 'next/server';
import { getSessionHelper } from '@/lib/auth-helper';
import { forwardSse } from '@/lib/sse/sse-gateway-driver';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await getSessionHelper();
  const userId = session?.user?.id;
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  return forwardSse(req, `/api/ingest-jobs/${encodeURIComponent(id)}/events`, { userId });
}
