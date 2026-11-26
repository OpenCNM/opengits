import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { executeSidecarCreditsLedger } from '@/engine/credits-driver';

export const GET = defineRoute({
  scope: 'GET /api/user/credits/ledger',
  auth: 'user',
  handler: async ({ request, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    const { searchParams } = new URL(request.url);
    const page = Math.max(parseInt(searchParams.get('page') || '1', 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(searchParams.get('pageSize') || '20', 10) || 20, 1), 100);

    const result = await executeSidecarCreditsLedger(userId, page, pageSize);
    return ok(result);
  },
});
