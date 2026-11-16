import { z } from 'zod';

/**
 * 站内通知契约（GET /api/notifications + PATCH /api/notifications/read）。
 * 三层同步层（Prisma Notification 模型 ↔ 本 schema ↔ 路由响应）。
 */

/** 通知类型词表（DB 侧为 String + 注释枚举，不使用 Prisma enum，与 346 三层同步模型对齐） */
export const NOTIFICATION_TYPES = {
  // 1. 异步任务终态（报喜也报忧）
  TRANSCRIPTION_DONE: 'transcription_done',
  TRANSCRIPTION_FAILED: 'transcription_failed',
  // 2. 教程发布与审核闭环
  TUTORIAL_PUBLISHED: 'tutorial_published',
  TUTORIAL_REJECTED: 'tutorial_rejected',
  // 3. 激励与社区荣誉
  TRANSCRIPTION_REWARD: 'transcription_reward',
  VERSION_WON: 'version_won',
  // 4. 接力与试读
  RELAY_OPEN: 'relay_open',
  CHAPTER_TRIAL_OPEN: 'chapter_trial_open',
  // 5. 自动同步
  AUTO_SYNC_APPLIED: 'auto_sync_applied',
} as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

export const NotificationItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  payload: z.unknown().nullable(),
  readAt: z.date().nullable(),
  createdAt: z.date(),
});

export type NotificationItem = z.infer<typeof NotificationItemSchema>;

export const MarkNotificationsReadSchema = z.object({
  /** 指定 id 列表；缺省 + all=true 时全部已读 */
  ids: z.array(z.string()).optional(),
  all: z.boolean().optional(),
});

export type MarkNotificationsReadInput = z.infer<typeof MarkNotificationsReadSchema>;
