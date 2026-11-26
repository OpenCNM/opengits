import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { MarkNotificationsReadSchema } from '@/lib/schemas/notification';
import { callSidecar } from '@/lib/sidecar-client';

export const dynamic = 'force-dynamic';

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
    const ids = body.ids ?? [];

    const res = await callSidecar<SidecarNotificationsReadResponse>(
      '/v1/notifications/read',
      { userId, ids, all: body.all ?? false },
      { label: 'notifications-read /v1/notifications/read', timeoutMs: 5_000 }
    );

    return ok({ updated: res.updated });
  },
});
