import { defineRoute } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { forwardSse } from '@/lib/sse/sse-gateway-driver';

export const dynamic = 'force-dynamic';

export const GET = defineRoute({
  scope: 'GET /api/notifications/stream',
  auth: 'user',
  handler: async ({ request, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    return forwardSse(request, '/api/notifications/stream', { userId });
  },
});
