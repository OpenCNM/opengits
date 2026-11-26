import type { ChapterUpdateJobStatus } from '@/lib/state/status-vocabularies';

export type { ChapterUpdateJobStatus };

export type ChapterUpdatePhase =
  | 'PENDING'
  | 'CLAIMED_ACTIVE'
  | 'CLAIMED_STALE'
  | 'TRIAL_LEGACY'
  | 'SWAPPED'
  | 'REJECTED'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface ChapterUpdateLifecycleInput {
  status?: string | null;
  claimedUntil?: Date | string | null;
  now?: Date | number;
}

export interface ChapterUpdateLifecycleProjection {
  phase: ChapterUpdatePhase;
  isActive: boolean;
  isTerminal: boolean;
  leaseStale: boolean;
}

export type ClaimTranscribePollStatus = 'running' | 'completed' | 'failed';

export interface ClaimTranscribePollInput {
  docProcessed: boolean;
  jobStatus?: string | null;
  claimedUntil?: Date | string | null;
  errorMessage?: string | null;
  now?: Date | number;
}

export interface ClaimTranscribePollResult {
  status: ClaimTranscribePollStatus;
  error?: string;
}

export type RelayTaskPhase = 'running' | 'completed' | 'failed';
