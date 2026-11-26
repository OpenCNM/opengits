'use client';

import React from 'react';
import * as m from '@/paraglide/messages';
import type { UpstreamErrorPresentation } from '@/lib/llm-gateway/upstream-error-ui';
import { UpstreamErrorNotice } from '@/components/common/UpstreamErrorNotice';

interface OutlineErrorCardProps {
  isOffline: boolean;
  error: UpstreamErrorPresentation;
  onRestart: () => void;
  onRetry: () => void;
  onOpenApiKeyModal: () => void;
  onOpenPreferencesModal: () => void;
  onModelSwitched: () => void;
}

export function OutlineErrorCard({
  isOffline,
  error,
  onRestart,
  onRetry,
  onOpenApiKeyModal,
  onOpenPreferencesModal,
  onModelSwitched,
}: OutlineErrorCardProps) {
  return (
    <UpstreamErrorNotice
      variant="card"
      isOffline={isOffline}
      error={error}
      onRestart={onRestart}
      restartLabel={m.import_outline_restart()}
      onRetry={onRetry}
      retryLabel={m.import_outline_retry()}
      onOpenApiKeyModal={onOpenApiKeyModal}
      onOpenPreferencesModal={onOpenPreferencesModal}
      onModelSwitched={onModelSwitched}
    />
  );
}
