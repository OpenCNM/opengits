import { callSidecar } from '@/lib/sidecar-client';

export interface SendNotificationItem {
  userId: string;
  type: string;
  title: string;
  body?: string | null;
  payload?: Record<string, unknown> | null;
}

/**
 * 统一站内通知发送咽喉（由 Go worker-sidecar 单写者落库）。
 * fire-and-forget，通知发送失败不阻塞主业务事务。
 */
export async function sendNotifications(
  items: SendNotificationItem | SendNotificationItem[]
): Promise<void> {
  const list = Array.isArray(items) ? items : [items];
  if (list.length === 0) return;

  try {
    const res = callSidecar<{ ok: boolean; count: number }>(
      '/v1/notifications/create',
      {
        notifications: list.map((item) => ({
          userId: item.userId,
          type: item.type,
          title: item.title,
          body: item.body || undefined,
          payload: item.payload ?? {},
        })),
      },
      { label: 'notifications-create' }
    );
    if (res && typeof res.catch === 'function') {
      res.catch((err) => {
        console.warn('[notification-sender] sendNotifications async drop:', err);
      });
    }
  } catch (err) {
    console.warn('[notification-sender] sendNotifications sync drop:', err);
  }
}
