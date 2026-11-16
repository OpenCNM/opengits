import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { checkRateLimit } from '@/lib/rate-limit';
import { cachedDefaultBranchRepository } from '@/lib/mcp/repo-resolve-cache';
import { callSidecar } from '@/lib/sidecar-client';

/**
 * 「有帮助」toggle（推荐分社区认可信号）：
 * POST /api/repos/[owner]/helpful?repo=x —— 一人一仓一票，再点取消；
 * 下沉至 Go worker-sidecar 原生 pgx 行级排他锁事务执行（零 Prisma $transaction 开销）。
 */
export const POST = defineRoute({
  scope: 'POST /api/repos/[owner]/helpful',
  auth: 'user',
  handler: async ({ request, params, userId }) => {
    // auth:'user' 已拦截未登录；此处收窄仅为类型细化（防御性，不可达）
    if (!userId) throw ApiError.unauthorized();
    if (!(await checkRateLimit(`helpful:${userId}`, 10, 60000))) {
      throw ApiError.tooManyRequests('操作过于频繁');
    }

    const { owner } = params;
    const repoName = new URL(request.url).searchParams.get('repo');
    if (!repoName) {
      throw ApiError.badRequest('Missing repo param');
    }

    const repository = await cachedDefaultBranchRepository(owner, repoName);
    if (!repository) {
      throw ApiError.notFound('Repository not found');
    }
    if (!(await verifyRepoAccessDirect({ id: repository.id, isPublic: repository.isPublic }, userId))) {
      throw ApiError.forbidden('Forbidden');
    }

    const res = await callSidecar<{ ok: boolean; voted: boolean; helpfulCount: number }>(
      '/v1/repos/helpful',
      { repositoryId: repository.id, userId },
      { label: 'repos-helpful /v1/repos/helpful', timeoutMs: 5_000 }
    );

    return ok({ voted: res.voted, helpfulCount: res.helpfulCount });
  },
});
