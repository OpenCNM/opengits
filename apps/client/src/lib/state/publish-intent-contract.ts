import type { ReviewStatus } from '@/lib/review/config';

export interface PublishIntentInput {
  publishRequested?: boolean | null;
  isPublic?: boolean | null;
  reviewStatus?: ReviewStatus | string | null;
  allProcessed?: boolean;
}

export type PublishIntentState =
  | 'IDLE'
  | 'READY_TO_SUBMIT'
  | 'PENDING_REVIEW'
  | 'PUBLISHED'
  | 'REJECTED'
  | 'INELIGIBLE';
