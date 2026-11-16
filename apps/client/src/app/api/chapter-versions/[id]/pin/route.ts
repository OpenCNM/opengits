import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { checkRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * POST /api/chapter-versions/[id]/pin —— 教程维护者设为推荐正典。
 * 下沉至 Go worker-sidecar 原生事务执行。
 */
export const POST = defineRoute<{ id: string }>({
  scope: 'POST /api/chapter-versions/[id]/pin',
  auth: 'user',
  handler: async ({ params, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    if (!(await checkRateLimit(`version-pin:${userId}`, 10, 60_000))) {
      throw ApiError.tooManyRequests('操作过于频繁');
    }

    const { id } = params;
    const { pinChapterVersion, VersionMarketError } = await import('@/lib/update-market/versions');
    try {
      const result = await pinChapterVersion(id, userId);
      return ok(result);
    } catch (err) {
      if (err instanceof VersionMarketError) {
        throw new ApiError(err.code === 'NOT_FOUND' ? 404 : 403, err.message, { code: err.code });
      }
      throw err;
    }
  },
});
