import { z } from 'zod';

export const NOTIFICATION_TYPES = {
  TRANSCRIPTION_DONE: 'transcription_done',
  TRANSCRIPTION_FAILED: 'transcription_failed',
  TUTORIAL_PUBLISHED: 'tutorial_published',
  TUTORIAL_REJECTED: 'tutorial_rejected',
  TRANSCRIPTION_REWARD: 'transcription_reward',
  VERSION_WON: 'version_won',
  RELAY_OPEN: 'relay_open',
  CHAPTER_TRIAL_OPEN: 'chapter_trial_open',
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
  ids: z.array(z.string()).optional(),
  all: z.boolean().optional(),
});

export type MarkNotificationsReadInput = z.infer<typeof MarkNotificationsReadSchema>;
