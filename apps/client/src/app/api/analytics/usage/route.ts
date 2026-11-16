import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { TokenUsageService } from '@/lib/analytics/token-usage';

export const GET = defineRoute({
  scope: 'GET /api/analytics/usage',
  auth: 'user',
  handler: async ({ request, userId }) => {
    // auth:'user' 已拦截未登录；此处收窄仅为类型细化（防御性，不可达）
    if (!userId) throw ApiError.unauthorized();

    const { searchParams } = new URL(request.url);
    const timeRange = searchParams.get('timeRange') || '30d';

    const stats = await TokenUsageService.getUsageStatistics(userId, { timeRange });

    return ok(stats);
  },
});
