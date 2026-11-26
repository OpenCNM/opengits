import { defineRoute } from '@/lib/api/server/define-route';
import { forwardSse } from '@/lib/sse/sse-gateway-driver';

export const dynamic = 'force-dynamic';

export const GET = defineRoute<{ owner: string; repo: string }>({
  scope: 'GET /api/ingest/[owner]/[repo]/events',
  auth: 'public',
  handler: async ({ params, userId, request }) => {
    const { owner, repo } = params;
    return forwardSse(
      request,
      `/api/ingest/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/events`,
      { userId }
    );
  },
});
