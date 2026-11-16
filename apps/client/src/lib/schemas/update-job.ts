/**
 * 章节级更新市场契约（三层同步层：Prisma ChapterUpdateJob ↔ 本 schema ↔ API 响应）。
 * 状态机（现行）：PENDING → CLAIMED → SWAPPED（机检即入库直换）；FAILED/CANCELLED 终态；
 * CLAIMED 超租约回 PENDING。
 * TRIAL/REJECTED 为试读表决时代的存量状态：不再产生新行，由 Go 侧 sweep 超时
 * 默认换入排水收敛（ACTIVE_JOB_STATUSES 仍计入，防止基线提前推进）。
 * kind：UPDATE = 上游变更重译；RELAY = 巨仓首译开荒（按需点译惰性生成）。
 */

export const CHAPTER_UPDATE_JOB_STATUS = {
  PENDING: 'PENDING',
  CLAIMED: 'CLAIMED',
  TRIAL: 'TRIAL',
  SWAPPED: 'SWAPPED',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

export type ChapterUpdateJobStatus = (typeof CHAPTER_UPDATE_JOB_STATUS)[keyof typeof CHAPTER_UPDATE_JOB_STATUS];

export const CHAPTER_UPDATE_JOB_KIND = {
  UPDATE: 'UPDATE',
  RELAY: 'RELAY',
} as const;

export type ChapterUpdateJobKind = (typeof CHAPTER_UPDATE_JOB_KIND)[keyof typeof CHAPTER_UPDATE_JOB_KIND];

/** 活跃态（建 job 幂等去重与"清零结算"判据；含存量 TRIAL 排水行） */
export const ACTIVE_JOB_STATUSES: ChapterUpdateJobStatus[] = ['PENDING', 'CLAIMED', 'TRIAL'];
