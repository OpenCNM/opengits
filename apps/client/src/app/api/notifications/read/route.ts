import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { MarkNotificationsReadSchema } from '@/lib/schemas/notification';
import { callSidecar } from '@/lib/sidecar-client';

export const dynamic = 'force-dynamic';

/**
 * PATCH /api/notifications/read —— 标记已读（按 id 列表或全部）。
 * 在共享 schema 上叠加路由级不变量：ids 与 all 至少提供一个有效目标。
 * 下沉至 Go worker-sidecar 原生 pgx 执行，Node 保持零 Prisma 依赖与微秒级桥接。
 */
const MarkReadRouteSchema = MarkNotificationsReadSchema.refine(
  (v) => v.all || (v.ids?.length ?? 0) > 0,
  { message: 'ids or all is required' }
);

interface SidecarNotificationsReadResponse {
  ok: boolean;
  updated: number;
}

export const PATCH = defineRoute({
  scope: 'PATCH /api/notifications/read',
  auth: 'user',
  bodySchema: MarkReadRouteSchema,
  handler: async ({ body, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    // schema refine 保证：all 为 false 时 ids 必为非空数组，此处 ?? 仅为类型收窄
    const ids = body.ids ?? [];

    const res = await callSidecar<SidecarNotificationsReadResponse>(
      '/v1/notifications/read',
      { userId, ids, all: body.all ?? false },
      { label: 'notifications-read /v1/notifications/read', timeoutMs: 5_000 }
    );

    return ok({ updated: res.updated });
  },
});
