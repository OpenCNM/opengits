import type { DocumentStatus } from '@/lib/constants';
import type { TranscriptionJobStatus } from '@/lib/state/status-vocabularies';

export type CourseLifecycleState =
  | 'IDLE'
  | 'TRANSCRIBING'
  | 'PAUSED'
  | 'PARTIAL_READY'
  | 'FAILED';

export type ChapterLifecycleState =
  | 'READY'
  | 'RUNNING'
  | 'QUEUED'
  | 'PRIORITIZED'
  | 'FAILED';

export interface ChapterJobInput {
  status?: TranscriptionJobStatus | null;
  savedChunks?: number | null;
  totalChunks?: number | null;
  queuePosition?: number | null;
  etaSeconds?: number | null;
  claimedAt?: string | null;
  createdAt?: string | null;
  startedAt?: number | null;
  progress?: number | null;
  step?: string | null;
}

export interface ChapterDocumentInput {
  id: string;
  path: string;
  title?: string | null;
  status: DocumentStatus;
  errorMessage?: string | null;
  transcriptionJob?: ChapterJobInput | null;
  // Virtual chapters exist in outline only and must never receive queue/retry mutations.
  isVirtual?: boolean;
}

export interface ChapterProjectionOptions {
  prioritizedId?: string | null;
  currentProcessingId?: string | null;
  processingDocIds?: readonly string[] | null;
}

export interface CurriculumLedgerInput {
  transcriptionTokens?: number;
  transcriptionCreditsEarned?: number;
  dailyRemainingCalls?: number | null;
  totalSpentCredits?: number;
  isDailyCapReached?: boolean;
}

export interface CourseLifecycleProjection {
  state: CourseLifecycleState;
  total: number;
  processed: number;
  readyCount: number;
  runningCount: number;
  queuedCount: number;
  failedCount: number;
  progressPct: number;
  isCompleted: boolean;
}

// Once a server job exists (HANDOFF), transient stream drops must never downgrade state to FAILED.
export type WizardLifecycleState =
  | 'IDLE'
  | 'DISCOVERING'
  | 'CURATING'
  | 'SUBMITTING'
  | 'HANDOFF'
  | 'FAILED';

export interface WizardLifecycleInput {
  isOpen: boolean;
  step: number;
  isSubmitting?: boolean;
  submittedJobId?: string | null;
  ingestSuccessInfo?: unknown | null;
  ingestFailed?: boolean;
}

export type WizardCloseAction = 'close' | 'confirm-dirty' | 'confirm-abort';

export interface WizardCloseGuardInput extends WizardLifecycleInput {
  isOutlineDirty?: boolean;
}

export type WizardCapsuleStatusKind = 'loading' | 'action_required' | 'success' | 'error';

export interface WizardCapsuleState {
  statusKind: WizardCapsuleStatusKind;
  badgeLabel: string;
  detailText: string;
  actionHint: string;
}

export interface WizardCapsuleInput {
  isOpen: boolean;
  step: number;
  loading?: boolean;
  prefixLoading?: boolean;
  draftLoading?: boolean;
  isSubmitting?: boolean;
  submittedJobId?: string | null;
  scoutData?: unknown | null;
  customOutline?: readonly unknown[];
  logs?: readonly string[];
  ingestSuccessInfo?: unknown | null;
  ingestFailed?: boolean;
  scoutError?: unknown | null;
  outlineGenError?: string | null;
}

