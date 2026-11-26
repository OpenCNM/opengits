import type { PublishIntentInput, PublishIntentState } from './publish-intent-contract';

// Single source of truth for auto-publish readiness; APPROVED && !isPublic maps to INELIGIBLE to block automatic actions.
export function projectPublishIntent(input: PublishIntentInput): PublishIntentState {
  const { publishRequested, isPublic, reviewStatus, allProcessed } = input;

  if (isPublic) {
    return 'PUBLISHED';
  }
  if (reviewStatus === 'REJECTED') {
    return 'REJECTED';
  }
  if (reviewStatus === 'PENDING') {
    return 'PENDING_REVIEW';
  }
  if (reviewStatus === 'APPROVED') {
    return 'INELIGIBLE';
  }
  if (publishRequested && allProcessed) {
    return 'READY_TO_SUBMIT';
  }
  return 'IDLE';
}
