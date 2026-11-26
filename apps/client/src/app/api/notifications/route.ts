import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';

export const dynamic = 'force-dynamic';

interface SidecarNotificationItem {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string | null;
  payload: unknown;
  readAt: string | null;
  createdAt: string;
}

interface SidecarNotificationsListResponse {
  ok: boolean;
  items: SidecarNotificationItem[];
  total: number;
  unreadCount: number;
}

export const GET = defineRoute({
  scope: 'GET /api/notifications',
  auth: 'user',
  handler: async ({ request, userId }) => {
    if (!userId) throw ApiError.unauthorized();

    const url = new URL(request.url);
    const page = Math.max(parseInt(url.searchParams.get('page') || '1', 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(url.searchParams.get('pageSize') || '15', 10) || 15, 1), 100);

    const res = await callSidecar<SidecarNotificationsListResponse>(
      '/v1/notifications/list',
      { userId, page, pageSize },
      { label: 'notifications-list /v1/notifications/list', timeoutMs: 5_000 }
    );

    return ok({
      items: res.items ?? [],
      pagination: {
        total: res.total,
        totalPages: Math.max(1, Math.ceil(res.total / pageSize)),
        page,
        pageSize,
      },
      unreadCount: res.unreadCount,
    });
  },
});

interface SidecarNotificationsClearResponse {
  ok: boolean;
  deleted: number;
}

export const DELETE = defineRoute({
  scope: 'DELETE /api/notifications',
  auth: 'user',
  handler: async ({ userId }) => {
    if (!userId) throw ApiError.unauthorized();

    const res = await callSidecar<SidecarNotificationsClearResponse>(
      '/v1/notifications/clear',
      { userId },
      { label: 'notifications-clear /v1/notifications/clear', timeoutMs: 5_000 }
    );

    return ok({ deleted: res.deleted });
  },
});
