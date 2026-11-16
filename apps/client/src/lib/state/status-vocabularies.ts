/**
 * 全系统状态词汇单一聚合出口（SSOT Aggregator）。
 *
 * 各粒度词汇的「定义」仍留在其三层同步锚点（Prisma/Zod/schema 模块），
 * 本模块只做聚合转发与跨粒度补齐——所有消费方（store / 投影器 / 路由 / 视图）
 * 一律从本模块导入，杜绝手写 `'QUEUED'|'RUNNING'|...` 字面量并集的散落镜像。
 *
 * 粒度清单：
 * - 文档级：DocumentStatus（Prisma enum，经 constants re-export）
 * - 转录任务级：TRANSCRIPTION_JOB_STATUS（本模块定义，Go internal/transcription/states.go 镜像）
 * - 导入任务级：IMPORT_JOB_STATUS（lib/schemas/import-job.ts 定义，Go internal/jobs/states.go 同步）
 * - 章节更新市场级：CHAPTER_UPDATE_JOB_STATUS（lib/schemas/update-job.ts，Go internal/market/states.go SSOT）
 * - Dock 教程级：DockTutorialStatus（本模块定义，由课程生命周期投影映射而来）
 */

export { DocumentStatus } from '@/lib/constants';
export {
  IMPORT_JOB_STATUS,
  isTerminalJobStatus,
  type ImportJobStatus,
} from '@/lib/schemas/import-job';
export {
  CHAPTER_UPDATE_JOB_STATUS,
  CHAPTER_UPDATE_JOB_KIND,
  ACTIVE_JOB_STATUSES,
  type ChapterUpdateJobStatus,
  type ChapterUpdateJobKind,
} from '@/lib/schemas/update-job';

/**
 * 转录任务状态（worker-sidecar 任务行）。
 * 与 Go 侧 internal/transcription/states.go 逐字同步：DONE/FAILED 为终态，
 * 可被重新入队（regenerate → QUEUED）。
 */
export const TRANSCRIPTION_JOB_STATUS = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  DONE: 'DONE',
  FAILED: 'FAILED',
} as const;

export type TranscriptionJobStatus = (typeof TRANSCRIPTION_JOB_STATUS)[keyof typeof TRANSCRIPTION_JOB_STATUS];

/** 转录任务终态判定（DONE/FAILED；DONE 不阻塞 regenerate 重开 QUEUED） */
export function isTerminalTranscriptionJob(status: string | null | undefined): boolean {
  return status === TRANSCRIPTION_JOB_STATUS.DONE || status === TRANSCRIPTION_JOB_STATUS.FAILED;
}

/**
 * Dock 悬浮胶囊的教程级展示状态（持久化字段，localStorage 兼容旧数据）。
 * 注意：这是「教程粒度」而非「文档粒度」——'PROCESSED' 表示全书完结。
 * 取值由 dock-status-projector 从课程生命周期投影映射，QUEUED 仅作种子初值
 * （任务刚入库、首次轮询同步前的占位）。
 */
export type DockTutorialStatus = 'QUEUED' | 'PROCESSING' | 'PROCESSED' | 'ERROR';
