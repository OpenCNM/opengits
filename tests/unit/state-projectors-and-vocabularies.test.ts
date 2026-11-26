import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { projectDockTutorialFacts, dockStatusFromCourseLifecycle } from '@/lib/state/dock-status-projector';
import { projectPublishIntent } from '@/lib/state/publish-intent-projector';
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
import {
  CHAPTER_UPDATE_JOB_TRANSITIONS,
  canTransitionChapterUpdateJob,
  isTerminalChapterUpdateJob,
  projectChapterUpdateLifecycle,
  projectClaimTranscribePoll,
  deriveRelayTaskPhase,
} from '@/lib/state/chapter-update-state-projector';

describe('state-projectors-and-vocabularies', () => {
  it('projectDockTutorialFacts & dockStatusFromCourseLifecycle 教程级事实投影与宏观映射', () => {
    expect(
      projectDockTutorialFacts([
        { id: '1', path: 'a.md', status: DocumentStatus.PROCESSED, title: 'A' },
        { id: '2', path: 'b.md', status: DocumentStatus.PROCESSED, title: 'B' },
      ])
    ).toMatchObject({ dockStatus: 'PROCESSED', completedChapters: 2, totalChapters: 2, activeDocPath: null });

    expect(
      projectDockTutorialFacts([
        { id: '1', path: 'done.md', status: DocumentStatus.PROCESSED },
        { id: '2', path: 'running/now.md', status: DocumentStatus.PROCESSING },
        { id: '3', path: 'queued.md', status: DocumentStatus.UNPROCESSED },
      ])
    ).toMatchObject({ dockStatus: 'PROCESSING', activeDocPath: 'running/now.md', activeChapterTitle: 'now.md', completedChapters: 1 });

    expect(
      projectDockTutorialFacts([
        { id: '1', path: 'a.md', status: DocumentStatus.UNPROCESSED },
        { id: '2', path: 'b.md', status: DocumentStatus.UNPROCESSED },
      ])
    ).toMatchObject({ dockStatus: 'QUEUED', activeDocPath: 'a.md' });

    expect(
      projectDockTutorialFacts([
        { id: '1', path: 'a.md', status: DocumentStatus.ERROR },
        { id: '2', path: 'b.md', status: DocumentStatus.UNPROCESSED, transcriptionJob: null },
      ]).dockStatus
    ).toBe('PROCESSING');
    expect(
      projectDockTutorialFacts([
        { id: '1', path: 'a.md', status: DocumentStatus.ERROR },
        { id: '2', path: 'b.md', status: DocumentStatus.ERROR },
      ]).dockStatus
    ).toBe('ERROR');
    expect(
      projectDockTutorialFacts([
        { id: '1', path: 'a.md', status: DocumentStatus.PROCESSED },
        { id: '2', path: 'b.md', status: DocumentStatus.ERROR },
      ]).dockStatus
    ).toBe('ERROR');
    expect(projectDockTutorialFacts([])).toMatchObject({ totalChapters: 0, dockStatus: 'QUEUED' });

    expect(dockStatusFromCourseLifecycle('IDLE')).toBe('PROCESSED');
    expect(dockStatusFromCourseLifecycle('FAILED')).toBe('ERROR');
    expect(dockStatusFromCourseLifecycle('TRANSCRIBING')).toBe('PROCESSING');
    expect(dockStatusFromCourseLifecycle('PARTIAL_READY')).toBe('PROCESSING');
    expect(dockStatusFromCourseLifecycle('PAUSED')).toBe('PROCESSING');
  });

  it('projectPublishIntent 发布意图仲裁器全状态矩阵', () => {
    for (const reviewStatus of ['NONE', null, undefined] as const) {
      expect(projectPublishIntent({ publishRequested: true, isPublic: false, reviewStatus, allProcessed: true })).toBe('READY_TO_SUBMIT');
    }
    expect(projectPublishIntent({ publishRequested: true, isPublic: false, reviewStatus: 'NONE', allProcessed: false })).toBe('IDLE');
    expect(projectPublishIntent({ publishRequested: false, isPublic: false, reviewStatus: 'NONE', allProcessed: true })).toBe('IDLE');
    expect(projectPublishIntent({ publishRequested: false, isPublic: true, reviewStatus: 'REJECTED', allProcessed: false })).toBe('PUBLISHED');
    expect(projectPublishIntent({ publishRequested: true, isPublic: false, reviewStatus: 'PENDING', allProcessed: true })).toBe('PENDING_REVIEW');
    expect(projectPublishIntent({ publishRequested: true, isPublic: false, reviewStatus: 'REJECTED', allProcessed: true })).toBe('REJECTED');
    expect(projectPublishIntent({ publishRequested: true, isPublic: false, reviewStatus: 'APPROVED', allProcessed: true })).toBe('INELIGIBLE');
  });

  it('Status Vocabularies SSOT 与 Dock 写入权限架构守卫', () => {
    expect(Object.values(DocumentStatus)).toEqual(['UNPROCESSED', 'PROCESSING', 'PROCESSED', 'ERROR']);
    expect(Object.values(TRANSCRIPTION_JOB_STATUS)).toEqual(['QUEUED', 'RUNNING', 'DONE', 'FAILED']);
    expect([isTerminalTranscriptionJob('DONE'), isTerminalTranscriptionJob('FAILED'), isTerminalTranscriptionJob('QUEUED'), isTerminalTranscriptionJob(null)]).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(Object.values(IMPORT_JOB_STATUS)).toEqual(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']);
    expect([isTerminalJobStatus('COMPLETED'), isTerminalJobStatus('FAILED'), isTerminalJobStatus('RUNNING')]).toEqual([true, true, false]);
    expect(Object.values(CHAPTER_UPDATE_JOB_STATUS)).toEqual(['PENDING', 'CLAIMED', 'TRIAL', 'SWAPPED', 'REJECTED', 'FAILED', 'CANCELLED']);
    expect(ACTIVE_JOB_STATUSES).toEqual(['PENDING', 'CLAIMED', 'TRIAL']);
    const dockStatuses: DockTutorialStatus[] = ['QUEUED', 'PROCESSING', 'PROCESSED', 'ERROR'];
    expect(new Set(dockStatuses).size).toBe(4);

    const CLIENT_SRC_ROOT = join(__dirname, '../../apps/client/src');
    const ALLOWED_FILES = new Set(['lib/stores/transcription-dock-store.ts', 'lib/stores/dock-sync.ts']);
    const walk = (dir: string, acc: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, acc);
        else if (/\.(ts|tsx)$/.test(name)) acc.push(full);
      }
      return acc;
    };
    const violators = walk(CLIENT_SRC_ROOT)
      .map((f) => relative(CLIENT_SRC_ROOT, f).split('\\').join('/'))
      .filter((rel) => !ALLOWED_FILES.has(rel) && readFileSync(join(CLIENT_SRC_ROOT, rel), 'utf8').includes('addOrUpdateTutorial'));
    expect(violators).toEqual([]);
  });

  it('chapter-update-state-projector 与 Go states.go SSOT 迁移表逐边对拍', () => {
    const src = readFileSync(join(__dirname, '../../services/worker-sidecar/internal/market/states.go'), 'utf8');
    const values: Record<string, string> = {};
    for (const [, name, value] of src.matchAll(/MarketStatus(\w+)\s+ChapterUpdateJobStatus\s*=\s*"([A-Z]+)"/g)) {
      values[name] = value;
    }
    const mapMatch = src.match(/chapterUpdateJobTransitions\s*=\s*map\[ChapterUpdateJobStatus\]map\[ChapterUpdateJobStatus\]bool\{([\s\S]*?)\n\}/)!;
    const transitions: Record<string, string[]> = {};
    for (const [, fromName, targetsBlock] of mapMatch[1].matchAll(/MarketStatus(\w+):\s*\{([\s\S]*?)\},/g)) {
      transitions[values[fromName]] = [...targetsBlock.matchAll(/MarketStatus(\w+):\s*true/g)].map(([, t]) => values[t]);
    }
    expect(Object.keys(CHAPTER_UPDATE_JOB_TRANSITIONS).sort()).toEqual(Object.keys(transitions).sort());
    for (const [from, targets] of Object.entries(transitions)) {
      expect([...CHAPTER_UPDATE_JOB_TRANSITIONS[from as keyof typeof CHAPTER_UPDATE_JOB_TRANSITIONS]].sort(), from).toEqual([...targets].sort());
    }

    expect([
      canTransitionChapterUpdateJob('PENDING', 'CLAIMED'),
      canTransitionChapterUpdateJob('CLAIMED', 'PENDING'),
      canTransitionChapterUpdateJob('CLAIMED', 'SWAPPED'),
      canTransitionChapterUpdateJob('TRIAL', 'SWAPPED'),
      canTransitionChapterUpdateJob('PENDING', 'SWAPPED'),
      canTransitionChapterUpdateJob('SWAPPED', 'PENDING'),
      canTransitionChapterUpdateJob('NOT_A_STATUS', 'PENDING'),
    ]).toEqual([true, true, true, true, false, false, false]);

    for (const s of ['SWAPPED', 'REJECTED', 'FAILED', 'CANCELLED']) expect(isTerminalChapterUpdateJob(s)).toBe(true);
    for (const s of ['PENDING', 'CLAIMED', 'TRIAL']) expect(isTerminalChapterUpdateJob(s)).toBe(false);
  });

  it('projectChapterUpdateLifecycle / projectClaimTranscribePoll / deriveRelayTaskPhase 相位投影', () => {
    const now = new Date('2026-10-19T12:00:00Z');
    expect(projectChapterUpdateLifecycle({ status: 'CLAIMED', claimedUntil: new Date('2026-10-19T13:00:00Z'), now })).toMatchObject({
      phase: 'CLAIMED_ACTIVE',
      leaseStale: false,
    });
    expect(projectChapterUpdateLifecycle({ status: 'CLAIMED', claimedUntil: new Date('2026-10-19T11:00:00Z'), now })).toMatchObject({
      phase: 'CLAIMED_STALE',
      leaseStale: true,
    });
    expect(projectChapterUpdateLifecycle({ status: 'TRIAL' }).phase).toBe('TRIAL_LEGACY');
    expect(projectChapterUpdateLifecycle({ status: 'APPLIED' }).phase).toBe('SWAPPED');
    expect(projectChapterUpdateLifecycle({ status: 'WHATEVER' }).phase).toBe('UNKNOWN');

    expect(projectClaimTranscribePoll({ docProcessed: true, jobStatus: 'CLAIMED' })).toEqual({ status: 'completed' });
    expect(projectClaimTranscribePoll({ docProcessed: false, jobStatus: 'SWAPPED' })).toEqual({ status: 'completed' });
    expect(projectClaimTranscribePoll({ docProcessed: false, jobStatus: 'CLAIMED', claimedUntil: new Date('2026-10-19T13:00:00Z'), now })).toEqual({
      status: 'running',
    });
    expect(projectClaimTranscribePoll({ docProcessed: false, jobStatus: 'CLAIMED', claimedUntil: new Date('2026-10-19T11:00:00Z'), now })).toEqual({
      status: 'failed',
      error: '认领超时，任务已回池',
    });
    expect(projectClaimTranscribePoll({ docProcessed: false, jobStatus: 'FAILED', errorMessage: 'LLM 超时' })).toEqual({
      status: 'failed',
      error: 'LLM 超时',
    });
    expect(projectClaimTranscribePoll({ docProcessed: false, jobStatus: null })).toEqual({ status: 'failed', error: '任务不存在或已失效' });

    expect(deriveRelayTaskPhase({ result: { nodeId: 'n1' }, error: null })).toBe('completed');
    expect(deriveRelayTaskPhase({ result: null, error: 'x' })).toBe('failed');
    expect(deriveRelayTaskPhase({})).toBe('running');
  });
});
