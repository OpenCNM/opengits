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

export const ACTIVE_JOB_STATUSES: ChapterUpdateJobStatus[] = ['PENDING', 'CLAIMED', 'TRIAL'];
