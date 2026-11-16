import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';

/**
 * 阅读量自增（fire-and-forget）：路径参数为 repository id（[owner] 命名为历史契约）。
 * 调用一次即自增一次（上游/网关层统一管理限频与风控）。
 * 下沉至 Go worker-sidecar 原生 pgx 执行，Node 保持零 Prisma 依赖与微秒级桥接。
 */
export const POST = defineRoute<{ owner?: string; id?: string }>({
  scope: 'POST /api/repos/[owner]/view',
  auth: 'public',
  handler: async ({ params }) => {
    const repositoryId = params.owner || params.id;

    if (!repositoryId) {
      throw ApiError.badRequest('Repository ID is required');
    }

    try {
      await callSidecar(
        '/v1/repos/view',
        { repositoryId },
        { label: 'repos-view /v1/repos/view', timeoutMs: 3_000 }
      );
    } catch {
      // 阅读计数自增为 fire-and-forget，异常静默忽略
      return ok({});
    }

    return ok({});
  },
});
