'use client';

import React, { useState } from 'react';
import { AnimatedModal } from '@/components/ui/AnimatedModal';
import { Button } from '@/components/ui/button';
import { RotateCw, CheckCircle2, AlertCircle } from 'lucide-react';
import { Mermaid } from '@/components/mdx/DynamicClientComponents';
import { cn } from '@/lib/utils';
import * as m from '@/paraglide/messages';
import {
  useUpdatePlanWorkflow,
  getActionLabels,
  ACTION_STYLE,
  type PlanChapter,
  type UpdatePlanResponse,
  type Phase,
} from './hooks/useUpdatePlanWorkflow';

export { getActionLabels, ACTION_STYLE, type PlanChapter, type UpdatePlanResponse, type Phase };

export interface UpdatePlanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  owner: string;
  repo: string;
  branch?: string;
  edition?: string;
  onUpdated?: () => void;
}

export function UpdatePlanDialog({
  open,
  onOpenChange,
  owner,
  repo,
  branch,
  edition,
  onUpdated,
}: UpdatePlanDialogProps) {
  const {
    phase,
    plan,
    diffStats,
    architectureDrift,
    error,
    progressText,
    loadingStageText,
    handleStartAnalysis,
    retryPlan,
    handleApply,
    reset,
  } = useUpdatePlanWorkflow({
    open,
    onOpenChange,
    owner,
    repo,
    branch,
    edition,
    onUpdated,
  });

  const [showDriftDiagram, setShowDriftDiagram] = useState(false);

  const actionLabels = getActionLabels();
  const updates = plan?.chapters.filter((c) => c.action !== 'keep') ?? [];
  const updateCount = updates.filter((c) => c.action === 'update').length;
  const addCount = updates.filter((c) => c.action === 'add').length;
  const removeCount = updates.filter((c) => c.action === 'remove').length;

  const currentStep = phase === 'loading' ? 1 : phase === 'preview' ? 2 : 3;

  const liveSubtitle =
    phase === 'loading'
      ? loadingStageText
      : phase === 'preview'
      ? m.update_confirm_affected_chapters()
      : phase === 'applying'
      ? progressText || m.update_stage_applying()
      : phase === 'done'
      ? m.update_plan_success_title()
      : error || m.update_plan_apply_failed();

  return (
    <AnimatedModal
      isOpen={open}
      onClose={() => {
        if (phase === 'loading' || phase === 'preview' || phase === 'applying') return;
        reset();
        onOpenChange(false);
      }}
      preventBackdropClose={phase === 'loading' || phase === 'preview' || phase === 'applying'}
      showCloseButton={phase !== 'applying' && phase !== 'loading'}
      size="xl"
      showHeader={false}
      bodyClassName="p-0 overflow-hidden select-none"
    >
      <div className="px-6 py-4 border-b border-theme-border/60 bg-theme-surface/50 relative">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <span className="inline-flex items-center justify-center w-8 h-8 rounded-xl bg-theme-primary/15 text-theme-primary font-serif font-bold text-xs border border-theme-primary/30 shrink-0">
              ❖
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-serif font-bold text-theme-foreground">
                  {m.update_plan_title()}
                </h3>
                <span className="text-micro font-mono px-2 py-0.5 rounded-full bg-theme-bg border border-theme-border text-theme-muted font-normal shrink-0">
                  {owner}/{repo}{branch ? ` (${branch})` : ''}
                </span>
                <span className="text-micro font-mono px-1.5 py-0.2 rounded bg-theme-primary/10 text-theme-primary font-bold shrink-0 ml-auto mr-4">
                  {currentStep}/3
                </span>
              </div>
              <p className="text-xs text-theme-muted mt-0.5 font-sans truncate">{liveSubtitle}</p>
            </div>
          </div>
        </div>

        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-theme-border/30 overflow-hidden">
          <div
            className="h-full bg-theme-primary transition-all duration-500 ease-out"
            style={{ width: `${(currentStep / 3) * 100}%` }}
          />
        </div>
      </div>

      <div className="p-6">
        {phase === 'loading' && (
          <div className="py-10 flex flex-col items-center justify-center space-y-4 text-center font-sans">
            <div className="w-10 h-10 rounded-2xl bg-theme-primary/10 border border-theme-primary/20 flex items-center justify-center text-theme-primary">
              <RotateCw className="w-5 h-5 animate-spin text-theme-primary" />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-bold text-theme-foreground">
                {m.update_plan_generating()}
              </p>
              <p className="text-micro text-theme-muted font-mono">{m.update_plan_diff_hint()}</p>
            </div>
            <div className="w-40 h-1 bg-theme-surface rounded-full overflow-hidden border border-theme-border/60">
              <div className="h-full bg-theme-primary animate-pulse w-3/4 rounded-full" />
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className="py-8 text-center space-y-3">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-red-500/10 text-red-600 border border-red-500/20">
              <AlertCircle size={20} />
            </div>
            <div className="text-micro text-red-600 font-mono max-w-md mx-auto">{error}</div>
          </div>
        )}

        {phase === 'preview' && plan && (
          <div className="space-y-4 max-h-[48vh] overflow-y-auto pr-1">
            {plan.isFallback && (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start justify-between gap-3 text-xs">
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-bold text-amber-600 dark:text-amber-400">
                      {m.update_plan_ai_unavailable_title()}
                    </p>
                    <p className="text-theme-muted mt-0.5 leading-relaxed text-micro">
                      {plan.fallbackReason || m.update_plan_ai_unavailable_desc()}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={retryPlan}
                  className="px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-700 dark:text-amber-300 font-bold hover:bg-amber-500/30 transition-colors shrink-0 flex items-center gap-1.5 text-micro"
                >
                  <RotateCw className="w-3 h-3" />
                  {m.update_plan_retry_ai()}
                </button>
              </div>
            )}

            <div className="flex gap-2 flex-wrap text-micro font-mono">
              {updateCount > 0 && (
                <span className="px-2.5 py-1 rounded-lg bg-theme-primary/10 text-theme-primary border border-theme-primary/30 font-bold">
                  {m.toast_updated()} {updateCount}
                </span>
              )}
              {addCount > 0 && (
                <span className="px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-600 border border-emerald-500/30 font-bold">
                  {m.common_create()} {addCount}
                </span>
              )}
              {removeCount > 0 && (
                <span className="px-2.5 py-1 rounded-lg bg-red-500/10 text-red-600 border border-red-500/30 font-bold">
                  {m.common_delete()} {removeCount}
                </span>
              )}
              {diffStats && (
                <span className="px-2.5 py-1 rounded-lg bg-theme-surface border border-theme-border text-theme-muted">
                  Diff: {diffStats.modified} / {diffStats.added} / {diffStats.removed}
                </span>
              )}
            </div>

            {plan.summary && (
              <p className="text-micro text-theme-muted bg-theme-surface/70 border border-theme-border/80 rounded-xl p-3 leading-relaxed font-sans">
                {plan.summary}
              </p>
            )}

            {architectureDrift && (
              <div className="border border-theme-border/80 rounded-xl p-3.5 bg-theme-surface/60 space-y-2.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-serif font-bold text-theme-foreground">
                      {m.update_plan_impact_title()}
                    </span>
                    {architectureDrift.isCrossBoundary ? (
                      <span className="text-micro font-mono px-2 py-0.5 rounded-full border border-red-500/30 bg-red-500/10 text-red-600 font-bold">
                        {m.update_plan_impact_breaking()}
                      </span>
                    ) : architectureDrift.hasDrift ? (
                      <span className="text-micro font-mono px-2 py-0.5 rounded-full border border-theme-primary/30 bg-theme-primary/10 text-theme-primary font-bold">
                        {m.update_plan_impact_minor()}
                      </span>
                    ) : (
                      <span className="text-micro font-mono px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 font-bold">
                        {m.update_plan_impact_none()}
                      </span>
                    )}
                  </div>
                  {architectureDrift.driftMermaid && (
                    <button
                      type="button"
                      onClick={() => setShowDriftDiagram(!showDriftDiagram)}
                      className="text-micro font-mono text-theme-primary hover:underline cursor-pointer"
                    >
                      {showDriftDiagram ? m.update_plan_hide_diagram() : m.update_plan_show_diagram()}
                    </button>
                  )}
                </div>

                <p className="text-micro text-theme-muted font-sans leading-relaxed">
                  {architectureDrift.verdict}
                </p>

                {architectureDrift.affectedNodes.some((n) => n.status !== 'stable') && (
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {architectureDrift.affectedNodes
                      .filter((n) => n.status !== 'stable')
                      .map((n) => (
                        <span
                          key={n.nodeId}
                          className={cn(
                            "text-micro font-mono px-2 py-0.5 rounded-md border",
                            n.status === 'breaking'
                              ? "bg-red-500/10 text-red-600 border-red-500/30 font-bold"
                              : "bg-amber-500/10 text-amber-600 border-amber-500/30"
                          )}
                          title={n.summary}
                        >
                          {n.name} ({n.status === 'breaking' ? m.update_plan_status_breaking() : m.update_plan_status_minor()})
                        </span>
                      ))}
                  </div>
                )}

                {showDriftDiagram && architectureDrift.driftMermaid && (
                  <div className="pt-2 border-t border-theme-border/50 max-h-[35vh] overflow-y-auto">
                    <Mermaid chart={architectureDrift.driftMermaid} />
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              {updates.map((ch, i) => (
                <div
                  key={`${ch.path}-${i}`}
                  className="flex items-start gap-2.5 border border-theme-border/80 rounded-xl p-3 bg-theme-surface hover:border-theme-primary/30 transition-colors"
                >
                  <span
                    className={`shrink-0 text-micro font-mono font-bold px-2 py-0.5 rounded-md ${
                      ACTION_STYLE[ch.action]
                    }`}
                  >
                    {actionLabels[ch.action]}
                  </span>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="text-xs font-serif font-bold text-theme-foreground truncate">
                      {ch.title ?? ch.path}
                    </div>
                    <div className="text-micro text-theme-muted leading-relaxed font-sans">
                      {ch.reason || ch.path}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {phase === 'applying' && (
          <div className="py-10 flex flex-col items-center justify-center space-y-3 text-center">
            <RotateCw className="w-6 h-6 animate-spin text-theme-primary" />
            <p className="text-xs font-bold text-theme-foreground">{progressText}</p>
            <p className="text-micro text-theme-muted font-mono">{m.update_running_in_background()}</p>
          </div>
        )}

        {phase === 'done' && (
          <div className="py-8 flex flex-col items-center justify-center space-y-2 text-center">
            <div className="w-10 h-10 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-600">
              <CheckCircle2 size={22} />
            </div>
            <p className="text-xs font-bold text-theme-foreground">
              {m.update_plan_success_title()}
            </p>
            <p className="text-micro text-theme-muted font-mono">{m.update_plan_bg_hint()}</p>
          </div>
        )}
      </div>

      <div className="px-6 py-3 border-t border-theme-border/60 bg-theme-surface/30 flex justify-end gap-2">
        {phase === 'loading' && (
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            className="text-xs font-serif"
          >
            {m.common_cancel()}
          </Button>
        )}
        {phase === 'preview' && (
          <>
            <Button
              variant="outline"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
              className="text-xs font-serif"
            >
              {m.common_cancel()}
            </Button>
            <Button
              onClick={handleApply}
              className="text-xs font-serif bg-theme-primary hover:opacity-90 text-theme-primary-fg font-bold"
            >
              {m.update_plan_confirm_cta()}
            </Button>
          </>
        )}
        {phase === 'error' && (
          <>
            <Button
              variant="outline"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
              className="text-xs font-serif"
            >
              {m.common_close()}
            </Button>
            <Button
              onClick={handleStartAnalysis}
              className="text-xs font-serif bg-theme-primary hover:opacity-90 text-theme-primary-fg font-bold"
            >
              {m.common_retry()}
            </Button>
          </>
        )}
        {phase === 'done' && (
          <Button
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            className="text-xs font-serif bg-theme-primary text-theme-primary-fg hover:opacity-90 font-bold"
          >
            {m.common_done()}
          </Button>
        )}
      </div>
    </AnimatedModal>
  );
}
