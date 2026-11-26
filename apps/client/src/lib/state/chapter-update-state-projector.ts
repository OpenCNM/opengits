import { CHAPTER_UPDATE_JOB_STATUS, ACTIVE_JOB_STATUSES } from '@/lib/state/status-vocabularies';
import type { ChapterUpdateJobStatus } from '@/lib/state/status-vocabularies';
import { assertNever } from './exhaustive';
import type {
  ChapterUpdateLifecycleInput,
  ChapterUpdateLifecycleProjection,
  ChapterUpdatePhase,
  ClaimTranscribePollInput,
  ClaimTranscribePollResult,
  ClaimTranscribePollStatus,
  RelayTaskPhase,
} from './chapter-update-lifecycle-contract';

export type { ChapterUpdatePhase, ClaimTranscribePollStatus, RelayTaskPhase };

// Mirrored verbatim from Go internal/market/states.go (enforced by chapter-update-lifecycle test).
export const CHAPTER_UPDATE_JOB_TRANSITIONS: Readonly<
  Record<ChapterUpdateJobStatus, readonly ChapterUpdateJobStatus[]>
> = {
  PENDING: ['CLAIMED'],
  CLAIMED: ['PENDING', 'SWAPPED', 'FAILED'],
  TRIAL: ['SWAPPED', 'REJECTED', 'FAILED'],
  SWAPPED: [],
  REJECTED: [],
  FAILED: [],
  CANCELLED: [], // Retained in enum only; neither side writes CANCELLED.
};

export function canTransitionChapterUpdateJob(
  from: string,
  to: string
): boolean {
  const targets = CHAPTER_UPDATE_JOB_TRANSITIONS[from as ChapterUpdateJobStatus];
  if (!targets) return false;
  return targets.includes(to as ChapterUpdateJobStatus);
}

export function isTerminalChapterUpdateJob(status: string): boolean {
  const targets = CHAPTER_UPDATE_JOB_TRANSITIONS[status as ChapterUpdateJobStatus];
  return targets !== undefined && targets.length === 0;
}

function toTime(value: Date | string | number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

export function projectChapterUpdateLifecycle(
  input: ChapterUpdateLifecycleInput
): ChapterUpdateLifecycleProjection {
  const raw = input.status ?? null;
  const now = input.now !== undefined ? toTime(input.now, Date.now()) : Date.now();
  const leaseExpired =
    raw === CHAPTER_UPDATE_JOB_STATUS.CLAIMED &&
    input.claimedUntil != null &&
    toTime(input.claimedUntil) < now;

  let phase: ChapterUpdatePhase;
  switch (raw) {
    case 'APPLIED':
    case CHAPTER_UPDATE_JOB_STATUS.SWAPPED:
      phase = 'SWAPPED';
      break;
    case CHAPTER_UPDATE_JOB_STATUS.REJECTED:
      phase = 'REJECTED';
      break;
    case CHAPTER_UPDATE_JOB_STATUS.FAILED:
      phase = 'FAILED';
      break;
    case CHAPTER_UPDATE_JOB_STATUS.CANCELLED:
      phase = 'CANCELLED';
      break;
    case CHAPTER_UPDATE_JOB_STATUS.TRIAL:
      phase = 'TRIAL_LEGACY';
      break;
    case CHAPTER_UPDATE_JOB_STATUS.CLAIMED:
      phase = leaseExpired ? 'CLAIMED_STALE' : 'CLAIMED_ACTIVE';
      break;
    case CHAPTER_UPDATE_JOB_STATUS.PENDING:
      phase = 'PENDING';
      break;
    default:
      phase = 'UNKNOWN';
      break;
  }

  const isActive =
    phase === 'CLAIMED_ACTIVE' || phase === 'CLAIMED_STALE' || phase === 'TRIAL_LEGACY' || phase === 'PENDING';
  const isTerminal =
    phase === 'SWAPPED' || phase === 'REJECTED' || phase === 'FAILED' || phase === 'CANCELLED';

  return { phase, isActive, isTerminal, leaseStale: phase === 'CLAIMED_STALE' };
}

// Exhaustive switch on phase guarantees compile-time failure if new phases are added.
export function projectClaimTranscribePoll(
  input: ClaimTranscribePollInput
): ClaimTranscribePollResult {
  const lifecycle = projectChapterUpdateLifecycle({
    status: input.jobStatus,
    claimedUntil: input.claimedUntil,
    now: input.now,
  });

  if (input.docProcessed || lifecycle.phase === 'SWAPPED') {
    return { status: 'completed' };
  }

  switch (lifecycle.phase) {
    case 'CLAIMED_ACTIVE':
      return { status: 'running' };
    case 'CLAIMED_STALE':
      return { status: 'failed', error: '认领超时，任务已回池' };
    case 'FAILED':
      return { status: 'failed', error: input.errorMessage || '转录失败' };
    case 'PENDING':
    case 'TRIAL_LEGACY':
    case 'REJECTED':
    case 'CANCELLED':
    case 'UNKNOWN':
      if (input.jobStatus === null || input.jobStatus === undefined) {
        return { status: 'failed', error: '任务不存在或已失效' };
      }
      return { status: 'failed', error: '任务状态异常' };
    default:
      return assertNever(lifecycle.phase, 'projectClaimTranscribePoll');
  }
}

export function deriveRelayTaskPhase(facts: {
  result?: unknown | null;
  error?: string | null;
}): RelayTaskPhase {
  if (facts.result !== null && facts.result !== undefined) return 'completed';
  if (facts.error) return 'failed';
  return 'running';
}
