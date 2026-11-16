import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { executeSidecarCreditsLedger } from '@/engine/credits-driver';

/**
 * 积分流水（用户视角，聚合多源账本为时间线）：
 * 委托至 Go worker-sidecar 原生端点 (/v1/credits/ledger) 聚合查询，
 * 消除 Node V8 堆内存搬运与 Prisma 多表查询开销。
 */
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
