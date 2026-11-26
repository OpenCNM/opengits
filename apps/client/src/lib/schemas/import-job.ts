import { z } from 'zod';

export const IMPORT_JOB_STATUS = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export type ImportJobStatus = (typeof IMPORT_JOB_STATUS)[keyof typeof IMPORT_JOB_STATUS];

export function isTerminalJobStatus(status: string): boolean {
  return status === IMPORT_JOB_STATUS.COMPLETED || status === IMPORT_JOB_STATUS.FAILED;
}

export const IMPORT_JOB_EVENT_TYPES = ['log', 'done', 'error'] as const;

export const ImportJobEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  type: z.enum(IMPORT_JOB_EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()).nullable().optional(),
  createdAt: z.string(),
});

export const ImportJobSnapshotSchema = z.object({
  job: z.object({
    id: z.string(),
    owner: z.string(),
    repo: z.string(),
    branch: z.string(),
    edition: z.string(),
    status: z.string(),
    error: z.string().nullable(),
    finishedAt: z.string().nullable(),
    lastSeq: z.number().int(),
    progressInfo: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
  events: z.array(ImportJobEventSchema),
  queuePosition: z.number().int().nonnegative().nullable().optional(),
});

export type ImportJobEventDTO = z.infer<typeof ImportJobEventSchema>;
export type ImportJobSnapshotDTO = z.infer<typeof ImportJobSnapshotSchema>;

export const ImportJobCreatedSchema = z.object({
  jobId: z.string(),
});

export const ImportPublicationIntentSchema = z.object({
  kind: z.enum(['repo', 'web-doc', 'web-sync']).optional(),
  publishRequested: z.boolean().default(false),
});
