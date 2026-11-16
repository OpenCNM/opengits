import { describe, expect, it } from 'vitest';
import {
  CHAPTER_STALL_THRESHOLD_MS,
  evaluateChapterTranscriptionHealth,
} from '@/lib/ingest/chapter-health';

describe('evaluateChapterTranscriptionHealth', () => {
  const now = 1_700_000_000_000;

  it('treats UNPROCESSED with active repo sibling as healthy queued even after long wait', () => {
    const verdict = evaluateChapterTranscriptionHealth({
      docStatus: 'UNPROCESSED',
      jobStatus: null,
      hasActiveRepoSibling: true,
      serverUpdatedAtMs: null,
      fallbackActivityMs: now - 600_000,
      nowMs: now,
    });
    expect(verdict).toEqual({ isHealthyQueued: true, isStalled: false });
  });

  it('treats UNPROCESSED with QUEUED job as healthy queued', () => {
    const verdict = evaluateChapterTranscriptionHealth({
      docStatus: 'UNPROCESSED',
      jobStatus: 'QUEUED',
      hasActiveRepoSibling: false,
      serverUpdatedAtMs: null,
      fallbackActivityMs: now - 300_000,
      nowMs: now,
    });
    expect(verdict).toEqual({ isHealthyQueued: true, isStalled: false });
  });

  it('flags UNPROCESSED as stalled when no sibling or job is active past threshold', () => {
    const verdict = evaluateChapterTranscriptionHealth({
      docStatus: 'UNPROCESSED',
      jobStatus: null,
      hasActiveRepoSibling: false,
      serverUpdatedAtMs: null,
      fallbackActivityMs: now - (CHAPTER_STALL_THRESHOLD_MS + 1000),
      nowMs: now,
    });
    expect(verdict).toEqual({ isHealthyQueued: false, isStalled: true });
  });

  it('immediately detects stalled PROCESSING from server heartbeat even on fresh mount', () => {
    const verdict = evaluateChapterTranscriptionHealth({
      docStatus: 'PROCESSING',
      jobStatus: 'RUNNING',
      hasActiveRepoSibling: false,
      serverUpdatedAtMs: now - (CHAPTER_STALL_THRESHOLD_MS + 5000),
      fallbackActivityMs: now,
      nowMs: now,
    });
    expect(verdict).toEqual({ isHealthyQueued: false, isStalled: true });
  });

  it('keeps PROCESSING healthy when server heartbeat is recent', () => {
    const verdict = evaluateChapterTranscriptionHealth({
      docStatus: 'PROCESSING',
      jobStatus: 'RUNNING',
      hasActiveRepoSibling: false,
      serverUpdatedAtMs: now - 15_000,
      fallbackActivityMs: now - 200_000,
      nowMs: now,
    });
    expect(verdict).toEqual({ isHealthyQueued: false, isStalled: false });
  });

  it('never flags PROCESSED or ERROR as stalled', () => {
    expect(
      evaluateChapterTranscriptionHealth({
        docStatus: 'PROCESSED',
        jobStatus: null,
        hasActiveRepoSibling: false,
        serverUpdatedAtMs: now - 500_000,
        fallbackActivityMs: now - 500_000,
        nowMs: now,
      })
    ).toEqual({ isHealthyQueued: false, isStalled: false });

    expect(
      evaluateChapterTranscriptionHealth({
        docStatus: 'ERROR',
        jobStatus: 'FAILED',
        hasActiveRepoSibling: false,
        serverUpdatedAtMs: now - 500_000,
        fallbackActivityMs: now - 500_000,
        nowMs: now,
      })
    ).toEqual({ isHealthyQueued: false, isStalled: false });
  });
});
