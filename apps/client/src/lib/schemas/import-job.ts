import { z } from 'zod';

/**
 * ImportJob 三元同步层（Prisma schema / Zod / TS）。
 * 状态机：QUEUED → RUNNING → COMPLETED | FAILED（worker 心跳租约，过期惰性判 FAIL）。
 */

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

/** 进度事件词汇表：与 /api/ingest 旧 SSE 协议保持一致（ai_stream 为遗留死协议，不再产生） */
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
    /** 当前已产生的最大事件 seq（客户端续订游标锚点；无事件为 -1） */
    lastSeq: z.number().int(),
    /** 导入作业动态流式进度（step 与 progress 百分比，防止假死黑盒） */
    progressInfo: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
  events: z.array(ImportJobEventSchema),
  /** 并发闸门排队位：仅 QUEUED 时有值（前面还有几个任务）；非 QUEUED 为 null */
  queuePosition: z.number().int().nonnegative().nullable().optional(),
});

export type ImportJobEventDTO = z.infer<typeof ImportJobEventSchema>;
export type ImportJobSnapshotDTO = z.infer<typeof ImportJobSnapshotSchema>;

/** POST /api/ingest 成功响应 */
export const ImportJobCreatedSchema = z.object({
  jobId: z.string(),
});


/** Consent is not visibility. Only the publication safety gate may set isPublic. */
export const ImportPublicationIntentSchema = z.object({
  kind: z.enum(['repo', 'web-doc', 'web-sync']).optional(),
  publishRequested: z.boolean().default(false),
});
