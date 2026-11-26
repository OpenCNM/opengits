'use client';

import { useState } from 'react';

interface UsePublishStateOptions {
  isPublic?: boolean;
  publishedAt?: string;
  reviewStatus?: string | null;
  rejectionReason?: string | null;
}

export function usePublishState({
  isPublic,
  publishedAt,
  reviewStatus,
  rejectionReason,
}: UsePublishStateOptions) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isProgressOpen, setIsProgressOpen] = useState(false);
  const [relayEnabled, setRelayEnabled] = useState<boolean | undefined>(undefined);
  const [publishedState, setPublishedState] = useState<{ isPublic: boolean; publishedAt?: string }>({
    isPublic: isPublic ?? false,
    publishedAt,
  });
  const [reviewState, setReviewState] = useState<{ status: string | null; reason: string | null }>({
    status: reviewStatus ?? null,
    reason: rejectionReason ?? null,
  });

  return {
    isConfirmOpen,
    setIsConfirmOpen,
    isProgressOpen,
    setIsProgressOpen,
    relayEnabled,
    setRelayEnabled,
    publishedState,
    setPublishedState,
    reviewState,
    setReviewState,
  };
}
