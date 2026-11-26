'use client';

import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { useRouter } from 'next/navigation';
import * as m from '@/paraglide/messages';
import {
  usePublishPipeline,
  getPublishStages,
  STAGE_ORDER,
  type Stage,
} from './hooks/usePublishPipeline';

export { getPublishStages, STAGE_ORDER, type Stage };

interface PublishProgressModalProps {
  isOpen: boolean;
  onClose: () => void;
  owner: string;
  repo: string;
  repoId?: string;
  relayEnabled?: boolean;
  onSuccess?: () => void;
  onSubmitted?: () => void;
}

export function PublishProgressModal({
  isOpen,
  onClose,
  owner,
  repo,
  repoId,
  relayEnabled,
  onSuccess,
  onSubmitted,
}: PublishProgressModalProps) {
  const router = useRouter();
  const {
    currentStage,
    failedStage,
    errorMessage,
    publishScores,
    currentStepIdx,
    subtitleText,
  } = usePublishPipeline({
    isOpen,
    owner,
    repo,
    repoId,
    relayEnabled,
    onSuccess,
    onSubmitted,
  });

  const stages = getPublishStages();

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => !open && currentStage !== 'mutate' && onClose()}
    >
      <DialogContent className="max-w-md bg-theme-bg border border-theme-border font-serif p-6 shadow-lg">
        <DialogHeader>
          <DialogTitle className="text-base font-bold text-theme-foreground tracking-tight font-serif">
            {currentStage === 'complete'
              ? m.toast_publish_success()
              : currentStage === 'submitted'
              ? m.publish_review_submitted_title()
              : currentStage === 'failed'
              ? m.publish_failed_title()
              : m.publish_validating_title()}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 my-3 font-sans">
          <div className="flex items-center justify-between text-xs text-theme-foreground pb-2 border-b border-theme-border/60 font-serif">
            <span className="font-serif text-theme-muted transition-all duration-300 min-h-[18px]">
              {subtitleText}
            </span>
            <span className="font-serif text-xs text-theme-primary font-semibold tracking-wider shrink-0 ml-2">
              {currentStage === 'complete' || currentStage === 'submitted'
                ? m.status_completed()
                : currentStage === 'failed'
                ? m.status_failed()
                : `${
                    currentStage === 'dedup'
                      ? 'Ⅰ'
                      : currentStage === 'transcription'
                      ? 'Ⅱ'
                      : currentStage === 'quality'
                      ? 'Ⅲ'
                      : 'Ⅳ'
                  } / Ⅳ`}
            </span>
          </div>

          <div className="relative pl-7 space-y-3.5 my-4 py-1">
            <div className="absolute left-[11px] top-3 bottom-3 w-0.5 bg-theme-border/40" />

            {stages.map((s, idx) => {
              let status: 'completed' | 'active' | 'pending' | 'failed' = 'pending';
              if (currentStage === 'failed') {
                const failedIdx = STAGE_ORDER.indexOf(failedStage || 'dedup');
                if (idx < failedIdx) status = 'completed';
                else if (idx === failedIdx) status = 'failed';
                else status = 'pending';
              } else if (currentStage === 'complete') {
                status = 'completed';
              } else if (currentStepIdx > idx) {
                status = 'completed';
              } else if (currentStepIdx === idx) {
                status = 'active';
              }

              return (
                <div key={s.id} className="relative flex items-start justify-between gap-3">
                  <span
                    className={`absolute -left-[28px] top-0.5 flex items-center justify-center w-5 h-5 rounded-full text-micro font-serif font-bold transition-all ${
                      status === 'completed'
                        ? 'bg-theme-primary text-theme-primary-fg border border-theme-primary shadow-xs'
                        : status === 'active'
                        ? 'bg-theme-bg text-theme-primary border-2 border-theme-primary ring-2 ring-theme-primary/20'
                        : status === 'failed'
                        ? 'bg-theme-bg text-theme-accent border-2 border-theme-accent'
                        : 'bg-theme-bg text-theme-muted border border-theme-border'
                    }`}
                  >
                    {s.step}
                  </span>

                  <div className="flex flex-col">
                    <span
                      className={`text-xs font-serif ${
                        status === 'completed' || status === 'active'
                          ? 'font-bold text-theme-foreground'
                          : status === 'failed'
                          ? 'font-bold text-theme-accent'
                          : 'text-theme-muted font-normal'
                      }`}
                    >
                      {s.label}
                    </span>
                    <span className="text-micro text-theme-muted leading-relaxed transition-all duration-300">
                      {s.desc}
                    </span>
                  </div>

                  <span
                    className={`text-micro font-mono px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${
                      status === 'completed'
                        ? 'bg-theme-primary/10 text-theme-primary border-theme-primary/30'
                        : status === 'active'
                        ? 'bg-theme-primary/20 text-theme-primary border-theme-primary/40 animate-pulse'
                        : status === 'failed'
                        ? 'bg-theme-accent/10 text-theme-accent border-theme-accent/30'
                        : 'bg-theme-border/20 text-theme-muted border-theme-border/40'
                    }`}
                  >
                    {status === 'completed'
                      ? m.status_completed()
                      : status === 'active'
                      ? m.status_processing()
                      : status === 'failed'
                      ? m.status_rejected()
                      : m.common_waiting()}
                  </span>
                </div>
              );
            })}
          </div>

          {currentStage === 'failed' && (
            <Alert variant="warning">
              <AlertTitle className="font-serif font-bold text-theme-primary text-xs">
                {m.publish_failed_title()}
              </AlertTitle>
              <AlertDescription className="text-theme-muted text-xs leading-relaxed font-sans mt-0.5">
                {errorMessage}
              </AlertDescription>
            </Alert>
          )}

          {currentStage === 'submitted' && (
            <Alert variant="warning">
              <AlertTitle className="font-serif font-bold text-theme-foreground text-xs">
                {m.publish_review_submitted_title()}
              </AlertTitle>
              <AlertDescription className="text-theme-muted text-xs font-sans mt-0.5 leading-relaxed">
                {m.publish_review_submitted_desc()}
              </AlertDescription>
            </Alert>
          )}

          {currentStage === 'complete' && (
            <Alert variant="default">
              <AlertTitle className="font-serif font-bold text-theme-foreground text-xs">
                {m.publish_success_desc()}
                {publishScores
                  ? ` · ${publishScores.pipeline} / ${publishScores.llm}`
                  : ''}
              </AlertTitle>
              <AlertDescription className="text-theme-muted text-xs font-sans mt-0.5 leading-relaxed">
                {m.toast_latest_synced_desc()}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-4 border-t border-theme-border/40 font-sans text-xs">
          {currentStage === 'failed' && (
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded border border-theme-border text-theme-muted hover:text-theme-foreground hover:border-theme-foreground transition-colors cursor-pointer"
            >
              {m.common_close()}
            </button>
          )}

          {currentStage === 'submitted' && (
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded bg-theme-primary text-theme-primary-fg font-serif font-bold hover:opacity-90 transition-opacity cursor-pointer shadow-xs"
            >
              {m.common_know()}
            </button>
          )}

          {currentStage === 'complete' && (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded border border-theme-border text-theme-muted hover:text-theme-foreground hover:border-theme-foreground transition-colors cursor-pointer"
              >
                {m.common_done()}
              </button>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  router.push('/?tab=public');
                }}
                className="px-4 py-2 rounded bg-theme-primary text-theme-primary-fg font-serif font-bold hover:opacity-90 transition-opacity cursor-pointer shadow-xs"
              >
                {m.publish_goto_explore()}
              </button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
