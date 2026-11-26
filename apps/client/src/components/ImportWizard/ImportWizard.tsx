'use client';
import * as m from '@/paraglide/messages';
import React, { useMemo } from 'react';
import { Sparkles, Layers, Minus } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { SUPPORTED_LANGUAGES } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { inspectGithubUrl } from '@/lib/url-inspector';
import { formatWebDocTargetDisplay } from '@/lib/import-wizard/navigation';
import { resolveWebDocJourneyStage } from '@/lib/import-wizard/webdoc-scope';
import { wizardFlow, wizardSetters, useImportWizardStore } from '@/lib/stores/import-wizard-store';
import { ImportWizardProvider, useImportWizard } from './ImportWizardContext';
import { Step1URLInput } from './Step1URLInput';
import { ImportWorkbench } from './ImportWorkbench';
import { WizardModelBadge } from './common/WizardModelSelector';
import { WebDocStepBar } from './common/WebDocStepBar';
import { WebDocImportFlow } from './webdoc/WebDocImportFlow';

function ImportWizardInner() {
  const {
    isOpen, step, subStep, loading, handleCloseRequest, resetWizard,
    scoutData, showConfirmCloseDialog, setShowConfirmCloseDialog,
    showIngestAbortDialog, setShowIngestAbortDialog,
    showEmptyCategoryDialog, setShowEmptyCategoryDialog, emptyCategoriesCount, handleIngest,
    targetLanguage,
    importMode, webScoutPhase, ingestSuccessInfo, url, parsedUrlInfo, dedupInfo
  } = useImportWizard();

  const isCollapsed = useImportWizardStore((s) => s.isCollapsed);
  const teachingDepth = useImportWizardStore((s) => s.teachingDepth);
  const displayDepthLabel =
    teachingDepth === 'overview'
      ? m.import_depth_beginner()
      : teachingDepth === 'deep'
      ? m.import_depth_deep()
      : m.import_depth_standard();

  const liveIsWebUrl = useMemo(() => {
    const trimmed = url.trim();
    if (!trimmed) return false;
    return inspectGithubUrl(trimmed).resourceType === 'web-doc';
  }, [url]);

  const isWebPipeline = importMode === 'web' || (step === 1 && subStep === 'input' && liveIsWebUrl);
  const isWebFlowActive = importMode === 'web' && (subStep === 'web_confirm' || step >= 2);
  const webJourneyStage = resolveWebDocJourneyStage({
    step,
    subStep,
    webScoutPhase,
    ingestSuccess: Boolean(ingestSuccessInfo),
  });

  const webDocHostname = formatWebDocTargetDisplay(url).hostname;

  const ratio = scoutData?.profile?.docCodeRatio;
  const totalFiles = ratio ? (ratio.totalFiles || (ratio.docFiles + ratio.codeFiles)) : (scoutData?.fileCount || 0);
  const rawLangName = SUPPORTED_LANGUAGES.find((l: any) => l.code === targetLanguage)?.nativeName || SUPPORTED_LANGUAGES.find((l: any) => l.code === targetLanguage)?.name || m.language_simplified_chinese();
  const displayLangName = targetLanguage === 'none' ? m.language_original() : rawLangName;

  return (
    <>
      <Dialog
        open={isOpen && !isCollapsed}
        disablePointerDismissal={true}
        onOpenChange={(open, details) => {
          if (!open) {
            if (details?.reason === 'close-press' || details?.reason === 'imperative-action') {
              handleCloseRequest();
            }
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="max-w-5xl w-full bg-theme-bg border border-theme-border shadow-[inset_0_0_40px_rgba(0,0,0,0.01)] rounded-xl overflow-hidden flex flex-col max-h-[88vh] h-auto !p-0 select-none z-[100]"
        >
          <div className="flex items-center justify-between px-6 py-3.5 border-b border-theme-border/40 bg-theme-bg/60 shrink-0 select-none w-full text-left gap-4">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="min-w-0 flex-1">
                {(() => {
                  const targetOwner = scoutData?.owner || dedupInfo?.existingRepo?.owner || parsedUrlInfo?.owner;
                  const targetRepo = scoutData?.repo || dedupInfo?.existingRepo?.repo || parsedUrlInfo?.repo;
                  const showRepoHeader = Boolean(targetOwner && targetRepo && (scoutData || dedupInfo || step >= 2));

                  if (!showRepoHeader) {
                    return (
                      <div>
                        <h3 className="text-sm font-serif font-bold text-theme-foreground">
                          {isWebPipeline ? m.import_wizard_web_title({ host: webDocHostname }) : m.import_wizard_github_title()}
                        </h3>
                      </div>
                    );
                  }

                  return (
                    <div>
                      <div className="flex items-center gap-2.5">
                        <h3 className="text-sm font-semibold font-mono text-theme-foreground truncate tracking-tight">
                          {targetOwner}/{targetRepo}
                        </h3>

                        <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-theme-surface border border-theme-border/60 text-caption font-sans text-theme-muted shrink-0 shadow-2xs">
                          {scoutData?.branch && (
                            <span className="font-mono text-theme-muted">{scoutData.branch}</span>
                          )}
                          {scoutData?.branch && displayLangName && (
                            <span className="text-theme-border text-compact select-none">·</span>
                          )}
                          {step === 1 && subStep === 'directory_confirm' && !loading && !isWebPipeline ? (
                            <Select
                              value={targetLanguage}
                              onValueChange={(val) => {
                                if (val) wizardFlow.updateTargetLanguage(val);
                              }}
                            >
                              <SelectTrigger
                                aria-label={m.language_preference()}
                                className="h-auto w-auto border-0 bg-transparent px-0 py-0 text-caption font-medium text-theme-foreground/90 hover:text-theme-primary shadow-none focus:ring-0 gap-1 cursor-pointer transition-colors"
                              >
                                <SelectValue>{displayLangName}</SelectValue>
                              </SelectTrigger>
                              <SelectContent className="bg-theme-surface border border-theme-border/70 font-sans max-h-60 z-[120]">
                                {SUPPORTED_LANGUAGES.map((lang) => (
                                  <SelectItem
                                    key={lang.code}
                                    value={lang.code}
                                    className="text-xs font-sans cursor-pointer hover:bg-theme-primary/10"
                                  >
                                    {lang.nativeName || lang.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <span className="text-theme-foreground/90 font-medium">
                              {displayLangName}
                            </span>
                          )}
                          {!isWebPipeline && (
                            <>
                              <span className="text-theme-border text-compact select-none">·</span>
                              <span className="text-theme-foreground/90 font-medium">{displayDepthLabel}</span>
                            </>
                          )}
                          <WizardModelBadge variant="inline" prefixDot />
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>

            {!isWebPipeline && (
              <div className="hidden lg:flex items-center gap-1.5 font-serif text-caption shrink-0">
                <div className={`px-2.5 py-0.5 rounded-full flex items-center gap-1 transition-all ${
                  step === 1
                    ? 'bg-theme-primary/10 border border-theme-primary/30 text-theme-primary font-bold shadow-2xs'
                    : 'text-theme-muted/70 bg-theme-surface/50 border border-theme-border/40'
                }`}>
                  <span className="font-mono text-compact">1</span>
                  <span>{m.import_wizard_step_locate()}</span>
                </div>

                <span className="text-theme-muted/40 text-compact">➔</span>

                <div className={`px-2.5 py-0.5 rounded-full flex items-center gap-1 transition-all ${
                  step === 2
                    ? 'bg-theme-primary/10 border border-theme-primary/30 text-theme-primary font-bold shadow-2xs'
                    : 'text-theme-muted/70 bg-theme-surface/50 border border-theme-border/40'
                }`}>
                  <span className="font-mono text-compact">2</span>
                  <span>{m.import_wizard_step_orchestrate()}</span>
                </div>

                <span className="text-theme-muted/40 text-compact">➔</span>

                <div className={`px-2.5 py-0.5 rounded-full flex items-center gap-1 transition-all ${
                  step === 3
                    ? 'bg-theme-primary/10 border border-theme-primary/30 text-theme-primary font-bold shadow-2xs'
                    : 'text-theme-muted/70 bg-theme-surface/50 border border-theme-border/40'
                }`}>
                  <span className="font-mono text-compact">3</span>
                  <span>{m.import_wizard_step_build()}</span>
                </div>
              </div>
            )}

            {step >= 2 && (
              <button
                type="button"
                onClick={wizardSetters.collapseWizard}
                aria-label={m.import_wizard_collapse()}
                title={m.import_wizard_collapse()}
                className="group p-1.5 rounded-lg bg-transparent border border-theme-border/60 text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/90 focus:outline-none cursor-pointer transition-all flex items-center justify-center shrink-0"
              >
                <Minus className="w-3.5 h-3.5" />
              </button>
            )}

            <button
              type="button"
              onClick={handleCloseRequest}
              aria-label={m.common_cancel()}
              title={m.common_cancel()}
              className="px-2.5 py-1 text-xs font-serif font-medium text-theme-muted hover:text-rose-600 hover:bg-rose-500/10 border border-theme-border/60 hover:border-rose-500/30 rounded-lg transition-all cursor-pointer shrink-0"
            >
              {m.common_cancel()}
            </button>
          </div>

          {isWebPipeline && (
            <div className="px-6 py-2.5 border-b border-theme-border/40 bg-theme-surface/30 shrink-0">
              <WebDocStepBar
                activeStage={webJourneyStage}
                scoutFailed={webScoutPhase === 'failed'}
                onBackToInput={
                  step === 1 && subStep === 'web_confirm'
                    ? () => wizardFlow.goBackToInput()
                    : undefined
                }
                className="max-w-3xl mx-auto"
              />
            </div>
          )}

          <div className={cn(
            "w-full flex flex-col p-6 overflow-hidden flex-1 min-h-0",
            step === 1 && "overflow-y-auto custom-scrollbar"
          )}>
            {isWebFlowActive ? (
              <WebDocImportFlow />
            ) : step === 1 ? (
              <Step1URLInput />
            ) : (
              <ImportWorkbench />
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={showConfirmCloseDialog}
        onOpenChange={setShowConfirmCloseDialog}
        title={m.common_confirm_exit_title()}
        description={m.common_confirm_exit_desc()}
        confirmText={m.common_confirm()}
        cancelText={m.dashboard_continue()}
        variant="danger"
        onConfirm={resetWizard}
      />

      <ConfirmDialog
        open={showIngestAbortDialog}
        onOpenChange={setShowIngestAbortDialog}
        title={m.common_confirm_abort_title()}
        description={m.common_confirm_abort_desc()}
        confirmText={m.common_confirm()}
        cancelText={m.common_waiting()}
        variant="warning"
        onConfirm={resetWizard}
      />

      <ConfirmDialog
        open={showEmptyCategoryDialog}
        onOpenChange={setShowEmptyCategoryDialog}
        title={m.import_empty_chapter_warning()}
        description={m.import_empty_chapter_skip()}
        confirmText={m.dashboard_continue()}
        cancelText={m.scout_feedback_back_to_edit()}
        variant="warning"
        onConfirm={handleIngest}
      />
    </>
  );
}

export function ImportWizardModal() {
  return <ImportWizardInner />;
}

export { ImportWizardProvider, useImportWizard } from './ImportWizardContext';
