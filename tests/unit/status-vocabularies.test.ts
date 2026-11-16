import { describe, expect, it } from 'vitest';
import {
  DocumentStatus,
  TRANSCRIPTION_JOB_STATUS,
  isTerminalTranscriptionJob,
  IMPORT_JOB_STATUS,
  isTerminalJobStatus,
  CHAPTER_UPDATE_JOB_STATUS,
  ACTIVE_JOB_STATUSES,
  type DockTutorialStatus,
} from '@/lib/state/status-vocabularies';

describe('Status Vocabularies SSOT（状态词汇单一聚合出口）', () => {
  it('文档级 DocumentStatus 为 Prisma 四成员联合（单一来源转发）', () => {
    expect(Object.values(DocumentStatus)).toEqual(['UNPROCESSED', 'PROCESSING', 'PROCESSED', 'ERROR']);
  });

  it('转录任务级四态与 Go internal/transcription/states.go 逐字对齐', () => {
    expect(Object.values(TRANSCRIPTION_JOB_STATUS)).toEqual(['QUEUED', 'RUNNING', 'DONE', 'FAILED']);
  });

  it('转录任务终态判定：DONE/FAILED 终态，QUEUED/RUNNING/空 非终态', () => {
    expect(isTerminalTranscriptionJob('DONE')).toBe(true);
    expect(isTerminalTranscriptionJob('FAILED')).toBe(true);
    expect(isTerminalTranscriptionJob('QUEUED')).toBe(false);
    expect(isTerminalTranscriptionJob('RUNNING')).toBe(false);
    expect(isTerminalTranscriptionJob(null)).toBe(false);
    expect(isTerminalTranscriptionJob(undefined)).toBe(false);
  });

  it('导入任务级四态与终态判定转发自 lib/schemas/import-job', () => {
    expect(Object.values(IMPORT_JOB_STATUS)).toEqual(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']);
    expect(isTerminalJobStatus('COMPLETED')).toBe(true);
    expect(isTerminalJobStatus('FAILED')).toBe(true);
    expect(isTerminalJobStatus('RUNNING')).toBe(false);
  });

  it('章节更新市场级七态与活跃集转发自 lib/schemas/update-job', () => {
    expect(Object.values(CHAPTER_UPDATE_JOB_STATUS)).toEqual([
      'PENDING', 'CLAIMED', 'TRIAL', 'SWAPPED', 'REJECTED', 'FAILED', 'CANCELLED',
    ]);
    expect(ACTIVE_JOB_STATUSES).toEqual(['PENDING', 'CLAIMED', 'TRIAL']);
  });

  it('Dock 教程级状态为四值展示词汇（教程粒度，非文档粒度）', () => {
    const dockStatuses: DockTutorialStatus[] = ['QUEUED', 'PROCESSING', 'PROCESSED', 'ERROR'];
    expect(new Set(dockStatuses).size).toBe(4);
  });
});
