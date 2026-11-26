export const CHAPTER_STALL_THRESHOLD_MS = 90_000;

export interface ChapterHealthInput {
  docStatus: string | null | undefined;
  jobStatus: string | null | undefined;
  hasActiveRepoSibling: boolean;
  serverUpdatedAtMs: number | null;
  fallbackActivityMs: number;
  nowMs: number;
  stallThresholdMs?: number;
}

export interface ChapterHealthVerdict {
  isHealthyQueued: boolean;
  isStalled: boolean;
}

export function evaluateChapterTranscriptionHealth(input: ChapterHealthInput): ChapterHealthVerdict {
  const {
    docStatus,
    jobStatus,
    hasActiveRepoSibling,
    serverUpdatedAtMs,
    fallbackActivityMs,
    nowMs,
    stallThresholdMs = CHAPTER_STALL_THRESHOLD_MS,
  } = input;

  if (docStatus === 'PROCESSED' || docStatus === 'ERROR') {
    return { isHealthyQueued: false, isStalled: false };
  }

  if (docStatus !== 'PROCESSING') {
    const isHealthyQueued =
      jobStatus === 'QUEUED' ||
      jobStatus === 'RUNNING' ||
      hasActiveRepoSibling;

    if (isHealthyQueued) {
      return { isHealthyQueued: true, isStalled: false };
    }

    const refMs =
      serverUpdatedAtMs && serverUpdatedAtMs > 0
        ? serverUpdatedAtMs
        : fallbackActivityMs;
    return {
      isHealthyQueued: false,
      isStalled: nowMs - refMs > stallThresholdMs,
    };
  }

  const refMs =
    serverUpdatedAtMs && serverUpdatedAtMs > 0
      ? serverUpdatedAtMs
      : fallbackActivityMs;

  return {
    isHealthyQueued: false,
    isStalled: nowMs - refMs > stallThresholdMs,
  };
}
