'use client';
import * as m from '@/paraglide/messages';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BookOpen,
  BookMarked,
  Crown,
  GitFork,
  ExternalLink,
  RefreshCw,
  ArrowLeft,
  Sparkles,
  Layers,
  Cpu,
  Loader2,
} from 'lucide-react';
import {
  wizardFlow,
  wizardSetters,
  useImportWizardStore,
  type WizardDedupInfo,
} from '@/lib/stores/import-wizard-store';
import type { SameSourceSummary } from '@/lib/scout/pipeline/types';
import { SIGNAL_METHOD_LABELS } from '@/lib/similarity/types';
import { useActiveWizardModel } from '../common/WizardModelSelector';

interface DedupNoticeCardProps {
  dedupInfo: WizardDedupInfo | null;
  sameSource: SameSourceSummary | null;
  sameSourceVisible: boolean;
  setHasDismissedDedup: (dismissed: boolean) => void;
  resetWizard: () => void;
  handleScout: (overrideUrl?: string, options?: { forceScout?: boolean }) => Promise<void>;
}

export function DedupNoticeCard({
  dedupInfo,
  sameSource,
  sameSourceVisible,
  setHasDismissedDedup,
  resetWizard,
  handleScout,
}: DedupNoticeCardProps) {
  const router = useRouter();
  const scoutData = useImportWizardStore((s) => s.scoutData);
  const parsedUrlInfo = useImportWizardStore((s) => s.parsedUrlInfo);
  const url = useImportWizardStore((s) => s.url);
  const { activeModel } = useActiveWizardModel();

  const targetOwner = dedupInfo?.existingRepo?.owner || parsedUrlInfo?.owner || '';
  const targetRepo = dedupInfo?.existingRepo?.repo || parsedUrlInfo?.repo || '';
  const repoLabel =
    targetOwner && targetRepo
      ? `${targetOwner}/${targetRepo}`
      : url.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');

  const existingModels = dedupInfo?.existingRepo?.transcriptionModels || [];
  const existingModelStr = existingModels.length > 0 ? existingModels.join(', ') : '';
  const upstreamModels = dedupInfo?.upstreamRepo?.transcriptionModels || [];
  const upstreamModelStr = upstreamModels.length > 0 ? upstreamModels.join(', ') : '';

  const displayModel = activeModel || 'AI';
  const defaultEditionLabel = m.scout_edition_label_default({ model: displayModel });

  const isShelfOrExplore = Boolean(dedupInfo?.existsOnShelf || dedupInfo?.existsInExplore);
  const isPublicTutorial = Boolean(dedupInfo?.existingRepo?.isPublic || dedupInfo?.existsInExplore);
  const isMaintainer = Boolean(dedupInfo?.existingRepo?.isMaintainer);

  const isScenarioA = isShelfOrExplore && isPublicTutorial && !isMaintainer;
  const isScenarioB = isShelfOrExplore && isPublicTutorial && isMaintainer;
  const isScenarioC = isShelfOrExplore && !isPublicTutorial;

  const [pendingAction, setPendingAction] = useState<'edition' | 'proceed' | null>(null);
  const isPending = pendingAction !== null;

  const handleDismissWarning = () => {
    setHasDismissedDedup(true);
  };

  const handleBackToEdit = () => {
    wizardFlow.goBackToInput();
    useImportWizardStore.setState({
      scoutSteps: [],
      hasDismissedDedup: false,
      dedupInfo: null,
    });
  };

  const handleCreateEditionWithScout = async () => {
    setPendingAction('edition');
    wizardSetters.setCreateEdition(true);
    wizardSetters.setEditionLabel(defaultEditionLabel);
    handleDismissWarning();
    try {
      if (!scoutData) {
        await handleScout(undefined, { forceScout: true });
      } else {
        wizardFlow.enterOrchestration();
      }
    } finally {
      setPendingAction(null);
    }
  };

  const handleProceedWithScout = async () => {
    setPendingAction('proceed');
    handleDismissWarning();
    try {
      if (!scoutData) {
        await handleScout(undefined, { forceScout: true });
      } else {
        wizardFlow.enterOrchestration();
      }
    } finally {
      setPendingAction(null);
    }
  };

  const renderModelPill = (existingStr: string, dotColor = 'bg-emerald-500') => {
    if (!repoLabel) return null;

    return (
      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-theme-surface border border-theme-border/60 text-caption font-mono text-theme-foreground/90 mb-3 shadow-2xs">
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor} shrink-0`} />
        <span className="font-semibold">{repoLabel}</span>
        {existingStr && (
          <>
            <span className="text-theme-border text-compact select-none">·</span>
            <span
              className="inline-flex items-center gap-1 text-theme-muted font-normal"
              title={m.scout_existing_tutorial_model()}
            >
              <Cpu size={11} className="text-theme-muted/70 shrink-0" />
              <span>{existingStr}</span>
            </span>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="w-full max-w-lg mx-auto flex flex-col items-center text-center animate-in fade-in slide-in-from-bottom-2 duration-300 pt-2 pb-6 px-4">
      <div className="flex items-center justify-center gap-3 text-theme-primary w-full max-w-xs mx-auto mb-7 select-none">
        <span className="h-[1px] bg-theme-border/80 flex-1" />
        <span className="text-xs md:text-sm tracking-[0.3em] font-serif uppercase">
          {m.scout_dedup_section_title()}
        </span>
        <span className="h-[1px] bg-theme-border/80 flex-1" />
      </div>

      {isScenarioA && (
        <>
          <div className="w-14 h-14 rounded-2xl bg-theme-primary/10 border border-theme-primary/15 flex items-center justify-center text-theme-primary mx-auto mb-4 shadow-2xs">
            <BookOpen className="w-7 h-7" />
          </div>

          {renderModelPill(existingModelStr)}

          <h3 className="text-lg md:text-xl font-serif font-bold text-theme-foreground tracking-tight mb-2">
            {m.scout_scenario_a_title()}
          </h3>

          <p className="text-xs md:text-sm font-sans text-theme-muted leading-relaxed max-w-md mx-auto mb-6">
            {m.scout_scenario_a_desc()}
          </p>

          <div className="w-full max-w-xs mx-auto flex flex-col items-center gap-2.5">
            <button
              type="button"
              onClick={handleCreateEditionWithScout}
              disabled={isPending}
              className="w-full py-2.5 px-5 bg-theme-primary hover:bg-theme-primary/90 text-theme-primary-fg text-xs font-serif font-bold tracking-wide rounded-lg shadow-sm hover:shadow transition-all active:scale-[0.98] flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
            >
              {pendingAction === 'edition' ? (
                <Loader2 size={13} className="animate-spin shrink-0" />
              ) : (
                <Sparkles size={13} className="shrink-0" />
              )}
              <span>{m.scout_scenario_a_action_create()}</span>
            </button>

            {dedupInfo?.existingRepo && (
              <button
                type="button"
                onClick={() => {
                  resetWizard();
                  router.push(`/docs/${dedupInfo.existingRepo!.owner}/${dedupInfo.existingRepo!.repo}`);
                }}
                className="w-full py-2.5 px-5 bg-transparent hover:bg-theme-surface border border-theme-border/80 hover:border-theme-foreground/30 text-theme-foreground text-xs font-serif font-medium tracking-wide rounded-lg transition-all active:scale-[0.98] flex items-center justify-center gap-2 cursor-pointer"
              >
                <span>{m.scout_view_public_tutorial()}</span>
                <ExternalLink size={13} />
              </button>
            )}

            <button
              type="button"
              onClick={handleBackToEdit}
              className="text-caption font-sans text-theme-muted hover:text-theme-foreground transition-colors flex items-center gap-1.5 cursor-pointer pt-2"
            >
              <ArrowLeft size={12} />
              <span>{m.scout_feedback_back_to_edit()}</span>
            </button>
          </div>
        </>
      )}

      {isScenarioB && (
        <>
          <div className="w-14 h-14 rounded-2xl bg-theme-primary/10 border border-theme-primary/15 flex items-center justify-center text-theme-primary mx-auto mb-4 shadow-2xs">
            <Crown className="w-7 h-7" />
          </div>

          {renderModelPill(existingModelStr)}

          <h3 className="text-lg md:text-xl font-serif font-bold text-theme-foreground tracking-tight mb-2">
            {m.scout_scenario_b_title()}
          </h3>

          <p className="text-xs md:text-sm font-sans text-theme-muted leading-relaxed max-w-md mx-auto mb-6">
            {m.scout_scenario_b_desc()}
          </p>

          {dedupInfo?.hasUpdate && (
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-theme-primary/5 border border-theme-primary/20 text-theme-primary text-xs font-sans mb-5 max-w-md text-left">
              <RefreshCw size={13} className="shrink-0" />
              <span>
                {m.scout_feedback_repo_update_notice({
                  importedSha: String(dedupInfo.importedSha || '').slice(0, 7),
                  currentSha: String(dedupInfo.currentSha || '').slice(0, 7),
                })}
              </span>
            </div>
          )}

          <div className="w-full max-w-xs mx-auto flex flex-col items-center gap-2.5">
            <button
              type="button"
              onClick={handleCreateEditionWithScout}
              disabled={isPending}
              className="w-full py-2.5 px-5 bg-theme-primary hover:bg-theme-primary/90 text-theme-primary-fg text-xs font-serif font-bold tracking-wide rounded-lg shadow-sm hover:shadow transition-all active:scale-[0.98] flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
            >
              {pendingAction === 'edition' ? (
                <Loader2 size={13} className="animate-spin shrink-0" />
              ) : (
                <Sparkles size={13} className="shrink-0" />
              )}
              <span>{m.scout_scenario_b_action_create_edition()}</span>
            </button>

            {dedupInfo?.existingRepo && (
              <button
                type="button"
                onClick={() => {
                  resetWizard();
                  router.push(`/docs/${dedupInfo.existingRepo!.owner}/${dedupInfo.existingRepo!.repo}`);
                }}
                className="w-full py-2 px-4 text-xs font-serif text-theme-muted hover:text-theme-foreground transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <span>{m.scout_view_public_tutorial()}</span>
                <ExternalLink size={12} />
              </button>
            )}

            <button
              type="button"
              onClick={handleBackToEdit}
              className="text-caption font-sans text-theme-muted hover:text-theme-foreground transition-colors flex items-center gap-1.5 cursor-pointer pt-2"
            >
              <ArrowLeft size={12} />
              <span>{m.scout_feedback_back_to_edit()}</span>
            </button>
          </div>
        </>
      )}

      {isScenarioC && (
        <>
          <div className="w-14 h-14 rounded-2xl bg-theme-primary/10 border border-theme-primary/15 flex items-center justify-center text-theme-primary mx-auto mb-4 shadow-2xs">
            <BookMarked className="w-7 h-7" />
          </div>

          {renderModelPill(existingModelStr)}

          <h3 className="text-lg md:text-xl font-serif font-bold text-theme-foreground tracking-tight mb-2">
            {m.scout_scenario_c_title()}
          </h3>

          <p className="text-xs md:text-sm font-sans text-theme-muted leading-relaxed max-w-md mx-auto mb-6">
            {m.scout_scenario_c_desc()}
          </p>

          {dedupInfo?.hasUpdate && (
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-theme-primary/5 border border-theme-primary/20 text-theme-primary text-xs font-sans mb-5 max-w-md text-left">
              <RefreshCw size={13} className="shrink-0" />
              <span>
                {m.scout_feedback_repo_update_notice({
                  importedSha: String(dedupInfo.importedSha || '').slice(0, 7),
                  currentSha: String(dedupInfo.currentSha || '').slice(0, 7),
                })}
              </span>
            </div>
          )}

          <div className="w-full max-w-xs mx-auto flex flex-col items-center gap-2.5">
            <button
              type="button"
              onClick={handleCreateEditionWithScout}
              disabled={isPending}
              className="w-full py-2.5 px-5 bg-theme-primary hover:bg-theme-primary/90 text-theme-primary-fg text-xs font-serif font-bold tracking-wide rounded-lg shadow-sm hover:shadow transition-all active:scale-[0.98] flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
            >
              {pendingAction === 'edition' ? (
                <Loader2 size={13} className="animate-spin shrink-0" />
              ) : (
                <Sparkles size={13} className="shrink-0" />
              )}
              <span>{m.scout_scenario_c_action_create_edition()}</span>
            </button>

            {dedupInfo?.existingRepo && (
              <button
                type="button"
                onClick={() => {
                  resetWizard();
                  router.push(`/docs/${dedupInfo.existingRepo!.owner}/${dedupInfo.existingRepo!.repo}`);
                }}
                className="w-full py-2 px-4 text-xs font-serif text-theme-muted hover:text-theme-foreground transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <span>{m.scout_view_shelf_tutorial()}</span>
                <ExternalLink size={12} />
              </button>
            )}

            <button
              type="button"
              onClick={handleBackToEdit}
              className="text-caption font-sans text-theme-muted hover:text-theme-foreground transition-colors flex items-center gap-1.5 cursor-pointer pt-2"
            >
              <ArrowLeft size={12} />
              <span>{m.scout_feedback_back_to_edit()}</span>
            </button>
          </div>
        </>
      )}

      {!isShelfOrExplore && dedupInfo?.isFork && dedupInfo?.upstream && (
        <>
          <div className="w-14 h-14 rounded-2xl bg-theme-primary/10 border border-theme-primary/15 flex items-center justify-center text-theme-primary mx-auto mb-4 shadow-2xs">
            <GitFork className="w-7 h-7" />
          </div>

          {renderModelPill(upstreamModelStr, 'bg-amber-500')}

          <h3 className="text-lg md:text-xl font-serif font-bold text-theme-foreground tracking-tight mb-2">
            {m.scout_fork_detected()}
          </h3>

          <p className="text-xs md:text-sm font-sans text-theme-muted leading-relaxed max-w-md mx-auto mb-6">
            {m.scout_feedback_fork_desc_prefix()}{' '}
            <code className="font-mono text-theme-foreground font-semibold px-1 py-0.5 rounded bg-theme-surface border border-theme-border/40">
              {dedupInfo.upstream.owner}/{dedupInfo.upstream.repo}
            </code>
            {dedupInfo.upstreamExistsInExplore
              ? m.scout_feedback_fork_in_explore_suffix()
              : m.scout_feedback_fork_import_official_suffix()}
          </p>

          <div className="w-full max-w-xs mx-auto flex flex-col items-center gap-2.5">
            {dedupInfo.upstreamExistsInExplore && dedupInfo.upstreamRepo ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    resetWizard();
                    router.push(`/docs/${dedupInfo.upstreamRepo!.owner}/${dedupInfo.upstreamRepo!.repo}`);
                  }}
                  className="w-full py-2.5 px-5 bg-theme-primary hover:bg-theme-primary/90 text-theme-primary-fg text-xs font-serif font-bold tracking-[0.1em] rounded-lg shadow-sm hover:shadow transition-all active:scale-[0.98] flex items-center justify-center gap-2 cursor-pointer"
                >
                  <span>{m.scout_view_official_master()}</span>
                  <ExternalLink size={13} />
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() =>
                    handleScout(`https://github.com/${dedupInfo.upstream!.owner}/${dedupInfo.upstream!.repo}`)
                  }
                  className="w-full py-2.5 px-5 bg-transparent hover:bg-theme-surface border border-theme-border/80 hover:border-theme-foreground/30 text-theme-foreground text-xs font-serif font-medium tracking-wide rounded-lg transition-all active:scale-[0.98] flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
                >
                  {m.scout_switch_to_official()}
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={handleProceedWithScout}
                  className="w-full py-1.5 text-theme-muted hover:text-theme-foreground text-xs font-serif transition-colors cursor-pointer disabled:opacity-60 flex items-center justify-center gap-1.5"
                >
                  {pendingAction === 'proceed' && <Loader2 size={13} className="animate-spin shrink-0" />}
                  <span>{m.scout_insist_import_fork()}</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() =>
                    handleScout(`https://github.com/${dedupInfo.upstream!.owner}/${dedupInfo.upstream!.repo}`)
                  }
                  className="w-full py-2.5 px-5 bg-theme-primary hover:bg-theme-primary/90 text-theme-primary-fg text-xs font-serif font-bold tracking-[0.1em] rounded-lg shadow-sm hover:shadow transition-all active:scale-[0.98] flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
                >
                  {m.scout_switch_to_official()}
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={handleProceedWithScout}
                  className="w-full py-2.5 px-5 bg-transparent hover:bg-theme-surface border border-theme-border/80 hover:border-theme-foreground/30 text-theme-foreground text-xs font-serif font-medium tracking-wide rounded-lg transition-all active:scale-[0.98] flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
                >
                  {pendingAction === 'proceed' && <Loader2 size={13} className="animate-spin shrink-0" />}
                  <span>{m.scout_insist_import_fork()}</span>
                </button>
              </>
            )}
            <button
              type="button"
              onClick={handleBackToEdit}
              className="text-caption font-sans text-theme-muted hover:text-theme-foreground transition-colors flex items-center gap-1.5 cursor-pointer pt-2"
            >
              <ArrowLeft size={12} />
              <span>{m.scout_feedback_back_to_edit()}</span>
            </button>
          </div>
        </>
      )}

      {sameSourceVisible && sameSource && (
        <>
          <div className="w-14 h-14 rounded-2xl bg-theme-primary/10 border border-theme-primary/15 flex items-center justify-center text-theme-primary mx-auto mb-4 shadow-2xs">
            <Layers className="w-7 h-7" />
          </div>

          {repoLabel && (
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-theme-surface border border-theme-border/60 text-caption font-mono text-theme-foreground/90 mb-3 shadow-2xs">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
              <span className="font-semibold">{repoLabel}</span>
            </div>
          )}

          <h3 className="text-lg md:text-xl font-serif font-bold text-theme-foreground tracking-tight mb-2">
            {m.scout_same_source_detected()}
          </h3>

          <p className="text-xs md:text-sm font-sans text-theme-muted leading-relaxed max-w-md mx-auto mb-6">
            {m.scout_feedback_same_source_desc_prefix()}{' '}
            <code className="font-mono text-theme-foreground font-semibold px-1 py-0.5 rounded bg-theme-surface border border-theme-border/40">
              {sameSource.owner}/{sameSource.repo}
            </code>{' '}
            {m.scout_feedback_same_source_desc_suffix({
              method: SIGNAL_METHOD_LABELS[sameSource.method] || sameSource.method,
              percent: Math.round(sameSource.similarity * 100),
            })}
          </p>

          <div className="w-full max-w-xs mx-auto flex flex-col items-center gap-2.5">
            <button
              type="button"
              onClick={() => {
                resetWizard();
                router.push(`/docs/${sameSource.owner}/${sameSource.repo}`);
              }}
              className="w-full py-2.5 px-5 bg-theme-primary hover:bg-theme-primary/90 text-theme-primary-fg text-xs font-serif font-bold tracking-[0.1em] rounded-lg shadow-sm hover:shadow transition-all active:scale-[0.98] flex items-center justify-center gap-2 cursor-pointer"
            >
              <span>{m.scout_feedback_review_existing_first()}</span>
              <ExternalLink size={13} />
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={handleProceedWithScout}
              className="w-full py-2.5 px-5 bg-transparent hover:bg-theme-surface border border-theme-border/80 hover:border-theme-foreground/30 text-theme-foreground text-xs font-serif font-medium tracking-wide rounded-lg transition-all active:scale-[0.98] flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
            >
              {pendingAction === 'proceed' && <Loader2 size={13} className="animate-spin shrink-0" />}
              <span>{m.scout_feedback_import_anyway()}</span>
            </button>
            <button
              type="button"
              onClick={handleBackToEdit}
              className="text-caption font-sans text-theme-muted hover:text-theme-foreground transition-colors flex items-center gap-1.5 cursor-pointer pt-2"
            >
              <ArrowLeft size={12} />
              <span>{m.scout_feedback_back_to_edit()}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
