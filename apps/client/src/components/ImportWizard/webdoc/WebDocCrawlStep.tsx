'use client';

import React, { useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, CheckCircle2, Loader2 } from 'lucide-react';
import * as m from '@/paraglide/messages';
import { Progress, ProgressIndicator, ProgressTrack } from '@/components/ui/progress';
import { UpstreamErrorNotice } from '@/components/common/UpstreamErrorNotice';
import { useImportJourneyTracker } from '@/hooks/useImportJourneyTracker';
import { buildImportedTutorialHref } from '@/lib/import-wizard/navigation';
import {
  resolveWebDocCrawlProgress,
  type WebDocCrawlStageKey,
} from '@/lib/import-wizard/webdoc-scope';
import { resolveUpstreamErrorPresentation } from '@/lib/llm-gateway/upstream-error-ui';
import { useImportWizardStore } from '@/lib/stores/import-wizard-store';
import { useModalStore } from '@/lib/stores/modal-store';
import { useImportWizard } from '../ImportWizardContext';

function resolveStageMessage(stageKey: WebDocCrawlStageKey): string {
  switch (stageKey) {
    case 'connecting':
      return m.webdoc_crawl_stage_connecting();
    case 'entry':
      return m.webdoc_crawl_stage_entry();
    case 'fetching':
      return m.webdoc_crawl_stage_fetching();
    case 'deep_fetching':
      return m.webdoc_crawl_stage_deep_fetching();
    case 'assets':
      return m.webdoc_crawl_stage_assets();
    case 'tree':
      return m.webdoc_crawl_stage_tree();
    case 'persisting':
    case 'done':
      return m.webdoc_crawl_stage_persisting();
  }
}

const subscribeOnlineStatus = (callback: () => void) => {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
};

const getOfflineSnapshot = () => (typeof navigator !== 'undefined' ? !navigator.onLine : false);
const getOfflineServerSnapshot = () => false;

export function WebDocCrawlStep() {
  const router = useRouter();

  const isOpen = useImportWizardStore((s) => s.isOpen);
  const step = useImportWizardStore((s) => s.step);
  const subStep = useImportWizardStore((s) => s.subStep);
  const url = useImportWizardStore((s) => s.url);
  const loading = useImportWizardStore((s) => s.loading);
  const prefixLoading = useImportWizardStore((s) => s.prefixLoading);
  const scoutData = useImportWizardStore((s) => s.scoutData);
  const logs = useImportWizardStore((s) => s.logs);
  const ingestSuccessInfo = useImportWizardStore((s) => s.ingestSuccessInfo);
  const ingestFailed = useImportWizardStore((s) => s.ingestFailed);
  const ingestError = useImportWizardStore((s) => s.ingestError);
  const scoutError = useImportWizardStore((s) => s.scoutError);

  const isOffline = useSyncExternalStore(
    subscribeOnlineStatus,
    getOfflineSnapshot,
    getOfflineServerSnapshot
  );

  const { setStep, setSubStep, retryWebDocImport, handleCloseRequest, resetWizard } =
    useImportWizard();

  useImportJourneyTracker({
    isOpen,
    step,
    subStep,
    url,
    loading,
    prefixLoading,
    scoutData,
    ingestSuccessInfo,
    ingestFailed,
    scoutError,
  });

  const handleGoToTutorial = () => {
    if (!ingestSuccessInfo) return;
    const targetUrl = buildImportedTutorialHref(ingestSuccessInfo);
    resetWizard();
    router.push(targetUrl);
  };

  if (ingestSuccessInfo) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-10 px-4 text-center space-y-6 max-w-md mx-auto w-full font-sans animate-in fade-in duration-300">
        <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 flex items-center justify-center shadow-xs">
          <CheckCircle2 size={28} />
        </div>

        <div className="space-y-1.5">
          <h3 className="text-base md:text-lg font-bold font-serif text-theme-foreground tracking-tight">
            {m.webdoc_crawl_ready_title()}
          </h3>
          <p className="text-xs md:text-sm text-theme-muted leading-relaxed">
            {m.webdoc_crawl_ready_desc()}
          </p>
        </div>

        <div className="w-full pt-1">
          <button
            type="button"
            onClick={handleGoToTutorial}
            className="w-full h-11 px-8 bg-theme-primary hover:opacity-95 text-theme-primary-fg font-serif font-bold text-sm tracking-wide rounded-xl transition-all shadow-md active:scale-[0.98] cursor-pointer flex items-center justify-center gap-2 group"
          >
            <span>{m.import_step3_web_enter_reading()}</span>
            <ArrowRight size={16} className="transition-transform group-hover:translate-x-1 shrink-0" />
          </button>
        </div>
      </div>
    );
  }

  if (ingestFailed) {
    const ingestPresentation = resolveUpstreamErrorPresentation(ingestError ?? null, {
      offline: isOffline,
      fallbackTitle: m.import_workbench_failed_title(),
      fallbackDesc: m.import_workbench_failed_desc(),
    });
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-8 px-4 max-w-xl mx-auto w-full font-sans">
        <UpstreamErrorNotice
          variant="banner"
          isOffline={isOffline}
          error={ingestPresentation}
          onRetry={retryWebDocImport}
          retryLabel={m.import_workbench_retry()}
          onModelSwitched={retryWebDocImport}
          onOpenPreferencesModal={() => {
            useModalStore.getState().openPreferencesModal('llm');
          }}
          onOpenApiKeyModal={() => {
            useModalStore.getState().openApiKeyModal({
              contextText:
                ingestPresentation.code === 'KEY_DECRYPT_FAILED'
                  ? m.toast_key_decrypt_failed_desc()
                  : m.toast_missing_api_key(),
              onCompleted: () => {
                void retryWebDocImport();
              },
            });
          }}
          extraActions={
            <>
              <button
                type="button"
                onClick={() => {
                  setSubStep('web_confirm');
                  setStep(1);
                }}
                className="inline-flex items-center justify-center gap-1.5 text-xs font-medium border border-theme-border text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-all cursor-pointer font-serif px-3.5 py-1.5 rounded-lg"
              >
                {m.scout_feedback_back_to_edit()}
              </button>
              <button
                type="button"
                onClick={handleCloseRequest}
                className="inline-flex items-center justify-center gap-1.5 text-xs font-medium border border-theme-border text-theme-muted hover:text-rose-600 hover:bg-theme-surface transition-all cursor-pointer font-serif px-3.5 py-1.5 rounded-lg"
              >
                {m.common_close()}
              </button>
            </>
          }
        />
      </div>
    );
  }

  const progress = resolveWebDocCrawlProgress(logs, false);
  const stageCopy = resolveStageMessage(progress.stageKey);

  return (
    <div className="flex-1 flex flex-col items-center justify-center py-12 px-4 max-w-lg mx-auto w-full font-sans animate-in fade-in duration-200">
      <div className="w-full space-y-4 text-center">
        <Progress value={progress.percent} aria-label={stageCopy}>
          <ProgressTrack className="h-2 w-full rounded-full bg-theme-border/60 overflow-hidden">
            <ProgressIndicator className="h-full rounded-full bg-theme-primary transition-all duration-500 ease-out" />
          </ProgressTrack>
        </Progress>

        <div className="flex items-center justify-center gap-2 text-sm font-medium text-theme-foreground">
          <Loader2 size={14} className="animate-spin text-theme-primary shrink-0" />
          <span>{stageCopy}</span>
        </div>

        <p className="text-caption text-theme-muted">
          {m.webdoc_crawl_helper_caption()}
        </p>
      </div>
    </div>
  );
}
