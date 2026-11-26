// Single import surface for status vocabularies across client stores, projectors, and Go state contracts.

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

export const TRANSCRIPTION_JOB_STATUS = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  DONE: 'DONE',
  FAILED: 'FAILED',
} as const;

export type TranscriptionJobStatus = (typeof TRANSCRIPTION_JOB_STATUS)[keyof typeof TRANSCRIPTION_JOB_STATUS];

export function isTerminalTranscriptionJob(status: string | null | undefined): boolean {
  return status === TRANSCRIPTION_JOB_STATUS.DONE || status === TRANSCRIPTION_JOB_STATUS.FAILED;
}

// Tutorial-level status persisted in localStorage; 'PROCESSED' denotes full-course completion.
export type DockTutorialStatus = 'QUEUED' | 'PROCESSING' | 'PROCESSED' | 'ERROR';
