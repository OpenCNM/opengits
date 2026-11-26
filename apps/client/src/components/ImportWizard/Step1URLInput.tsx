'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, Loader2, Languages, Globe, AlertTriangle, AlertCircle, Zap, Sparkles, GraduationCap } from 'lucide-react';
import { ThemedInput } from '@/components/ui/theme-input';
import { Alert } from '@/components/ui/alert';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverTrigger, PopoverPopup } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { inspectGithubUrl } from '@/lib/url-inspector';
import { useImportWizard } from './ImportWizardContext';
import { useImportWizardStore, wizardFlow } from '@/lib/stores/import-wizard-store';
import { triggerGithubReauth } from '@/lib/import-wizard/wizard-reauth';
import { ScoutFeedbackCard } from './ScoutFeedbackCard';
import { WizardModelSelector } from './common/WizardModelSelector';
import { SUPPORTED_LANGUAGES } from '@/lib/constants';
import * as m from '@/paraglide/messages';

import {
  useScoutPipelineProgression,
  getScoutPipelineStages,
  type ScoutStepEvent,
} from './hooks/useScoutPipelineViewer';

interface ScoutPipelineViewerProps {
  displayedCount: number;
  scoutSteps: ScoutStepEvent[];
}

function ScoutPipelineViewer({ displayedCount, scoutSteps }: ScoutPipelineViewerProps) {
  const { stageStates, stages } = useScoutPipelineProgression(true, scoutSteps);

  return (
    <motion.div
      layout
      transition={{ duration: 0.3, ease: 'easeInOut' }}
      className="w-full p-4 bg-theme-surface border border-theme-border/70 rounded-xl flex flex-col gap-3 text-left font-sans shadow-2xs"
    >
      <div className="flex items-center justify-between border-b border-theme-border/40 pb-2.5">
        <span className="font-bold text-theme-foreground tracking-wider uppercase font-serif text-xs">
          {m.scout_background_analyzing()}
        </span>
        <span className="text-theme-primary text-micro font-mono flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-theme-primary animate-ping" />
          <span>
            {Math.min(displayedCount + 1, stages.length)} / {stages.length}
          </span>
        </span>
      </div>

      <div className="flex flex-col gap-2 py-0.5">
        {stageStates.map(({ stageConfig, idx, isCompleted, isActive, title, detail }) => {
          return (
            <div
              key={stageConfig.stage}
              className={`p-2.5 rounded-lg border text-xs transition-all flex items-start gap-3 ${
                isCompleted
                  ? 'bg-theme-bg/60 border-theme-border/40 text-theme-foreground/80'
                  : isActive
                  ? 'bg-theme-primary/10 border-theme-primary/40 text-theme-foreground shadow-2xs'
                  : 'bg-theme-bg/30 border-theme-border/20 text-theme-muted/50'
              }`}
            >
              <div className="mt-0.5 shrink-0">
                {isCompleted ? (
                  <div className="w-4 h-4 rounded-full bg-theme-primary/20 text-theme-primary flex items-center justify-center">
                    <CheckCircle2 size={12} className="text-theme-primary" />
                  </div>
                ) : isActive ? (
                  <div className="w-4 h-4 rounded-full bg-theme-primary text-theme-primary-fg flex items-center justify-center">
                    <Loader2 size={11} className="animate-spin" />
                  </div>
                ) : (
                  <div className="w-4 h-4 rounded-full border border-theme-border/60 text-theme-muted/40 flex items-center justify-center font-mono text-micro">
                    {idx + 1}
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`font-serif font-bold ${
                      isActive
                        ? 'text-theme-primary'
                        : isCompleted
                        ? 'text-theme-foreground'
                        : 'text-theme-muted/60'
                    }`}
                  >
                    {title}
                  </span>
                  {isCompleted && (
                    <span className="text-compact font-mono text-theme-primary/80 font-medium">
                      {m.status_completed()}
                    </span>
                  )}
                  {isActive && (
                    <span className="text-compact font-mono text-theme-primary animate-pulse font-medium">
                      {m.status_processing()}
                    </span>
                  )}
                </div>
                <p
                  className={`text-caption leading-relaxed mt-0.5 truncate ${
                    isActive
                      ? 'text-theme-muted'
                      : isCompleted
                      ? 'text-theme-muted/80'
                      : 'text-theme-muted/40'
                  }`}
                >
                  {detail}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

function CreditsRulesPopover() {
  return (
    <Popover>
      <PopoverTrigger
        type="button"
        className="text-theme-primary font-medium underline underline-offset-2 hover:opacity-80 transition-opacity cursor-pointer inline-flex items-center gap-0.5"
      >
        <span>{m.step1_credits_keyword()}</span>
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        sideOffset={8}
        className="w-[280px] p-0 rounded-xl bg-theme-surface border border-theme-border shadow-xl backdrop-blur-xl text-theme-foreground font-sans animate-in fade-in zoom-in-95 duration-200"
        viewportClassName="p-3.5"
      >
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-1.5 border-b border-theme-border/40 pb-2 text-xs font-bold text-theme-foreground font-sans">
            <Zap className="w-3.5 h-3.5 text-amber-500 fill-amber-500/20 shrink-0" />
            <span>{m.step1_credits_rules_title()}</span>
          </div>
          <div className="flex flex-col gap-2 text-caption font-sans text-theme-muted leading-relaxed">
            <p>
              <strong className="text-theme-foreground font-semibold">{m.step1_credits_rule_consume_label()}</strong>
              {m.step1_credits_rule_consume_desc()}
            </p>
            <p>
              <strong className="text-theme-foreground font-semibold">{m.step1_credits_rule_earn_label()}</strong>
              {m.step1_credits_rule_earn_desc()}
            </p>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function Step1URLInput() {
  const {
    url,
    setUrl,
    handleScout,
    loading,
    isReauthorizing,
    scoutSteps,
    setHasDismissedDedup,
    scoutError,
    setScoutError,
    targetLanguage,
    setTargetLanguage,
    subStep,
    scoutData,
    dedupInfo,
    scoutSameSource,
    hasDismissedDedup,
    isPublic,
    setIsPublic,
    teachingDepth,
    setTeachingDepth,
    customPrompt,
    setCustomPrompt,
    importMode,
  } = useImportWizard();
  const scoutedUrl = useImportWizardStore((s) => s.scoutedUrl);
  const router = useRouter();

  const [isCustomMode, setIsCustomMode] = useState(Boolean(customPrompt?.trim()));
  const lastCustomPromptRef = useRef(customPrompt || '');

  useEffect(() => {
    if (customPrompt?.trim() && !isCustomMode) {
      setIsCustomMode(true);
    }
  }, [customPrompt, isCustomMode]);

  const depthOptions: Array<{
    key: 'overview' | 'standard' | 'deep' | 'custom';
    label: string;
    tip: string;
  }> = [
    { key: 'overview', label: m.import_depth_beginner(), tip: m.import_depth_beginner_tip() },
    { key: 'standard', label: m.import_depth_standard(), tip: m.import_depth_standard_tip() },
    { key: 'deep', label: m.import_depth_deep(), tip: m.import_depth_deep_tip() },
    { key: 'custom', label: m.import_depth_custom(), tip: m.import_depth_custom_tip() },
  ];

  const activeDepthKey: 'overview' | 'standard' | 'deep' | 'custom' = isCustomMode ? 'custom' : (teachingDepth || 'standard');

  const handleDepthSelect = (key: 'overview' | 'standard' | 'deep' | 'custom') => {
    if (key === 'custom') {
      setIsCustomMode(true);
      if (!customPrompt && lastCustomPromptRef.current) {
        setCustomPrompt(lastCustomPromptRef.current);
      }
    } else {
      setIsCustomMode(false);
      setTeachingDepth(key);
      if (customPrompt) {
        lastCustomPromptRef.current = customPrompt;
        setCustomPrompt('');
      }
    }
  };

  const { displayedCount } = useScoutPipelineProgression(loading, scoutSteps);

  const handleAuthRequired = () => {
    triggerGithubReauth({
      url: url.trim(),
    });
  };

  const hasUrlInput = url.trim().length > 0;
  const liveIsWebUrl = useMemo(() => {
    const trimmed = url.trim();
    if (!trimmed) return false;
    return inspectGithubUrl(trimmed).resourceType === 'web-doc';
  }, [url]);
  const effectiveDedup = dedupInfo ?? scoutData?.dedupInfo ?? null;
  const sameSourceVisible =
    scoutSameSource &&
    !effectiveDedup?.existsOnShelf &&
    !effectiveDedup?.existsInExplore &&
    !(effectiveDedup?.isFork && effectiveDedup?.upstream);
  const hasDuplicates = effectiveDedup && (effectiveDedup.existsOnShelf || effectiveDedup.existsInExplore || effectiveDedup.isFork);
  const showDedupCard = (hasDuplicates || sameSourceVisible) && !hasDismissedDedup;
  const hasCachedGithubScout =
    importMode === 'github' &&
    Boolean(scoutData) &&
    Boolean(scoutedUrl) &&
    scoutedUrl === url.trim() &&
    !liveIsWebUrl;

  if (showDedupCard && subStep !== 'input' && !loading) {
    return (
      <div className="flex flex-col items-center justify-center text-center animate-in fade-in slide-in-from-bottom-2 duration-300 w-full py-6 px-4 max-w-xl mx-auto">
        <ScoutFeedbackCard />
      </div>
    );
  }

  if (subStep === 'directory_confirm' && scoutData && !loading) {
    return (
      <div className="flex flex-col items-center justify-center text-center animate-in fade-in slide-in-from-bottom-2 duration-300 w-full pt-2 pb-6 px-4 max-w-3xl mx-auto">
        <div className="flex items-center justify-center gap-4 text-theme-foreground/70 w-full max-w-sm mx-auto mb-7 select-none">
          <span className="h-[1px] bg-gradient-to-r from-transparent via-theme-border/80 to-transparent flex-1" />
          <span className="text-xs tracking-[0.25em] font-sans font-semibold text-theme-muted hover:text-theme-foreground transition-colors uppercase">
            {m.step1_directory_confirm_title()}
          </span>
          <span className="h-[1px] bg-gradient-to-r from-transparent via-theme-border/80 to-transparent flex-1" />
        </div>

        <ScoutFeedbackCard />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center text-center animate-in fade-in slide-in-from-bottom-2 duration-300 w-full pt-4 pb-6 px-4 max-w-xl mx-auto">
      <div className="flex items-center justify-center gap-3 text-theme-primary w-full max-w-xs mx-auto mb-7 select-none">
        <span className="h-[1px] bg-theme-border/80 flex-1" />
        <span className="text-xs md:text-sm tracking-[0.3em] font-serif uppercase">
          {liveIsWebUrl ? m.webdoc_import_title() : m.import_title()}
        </span>
        <span className="h-[1px] bg-theme-border/80 flex-1" />
      </div>

 <div className="w-full space-y-3">
 <ThemedInput
 badge={m.step1_source_badge()}
 value={url}
 onChange={e => {
 setUrl(e.target.value);
 setHasDismissedDedup(false);
 if (scoutError) setScoutError(null);
 }}
 onKeyDown={e => e.key === 'Enter' && !loading && !isReauthorizing && handleScout()}
 action={
   scoutError && !loading && !isReauthorizing ? (
     <div 
       className="flex items-center gap-1 text-amber-600 dark:text-amber-400 pl-1 pr-1.5 animate-in fade-in zoom-in-90 duration-150 select-none" 
       title={scoutError.error || m.step1_error_invalid_url()}
     >
       <AlertTriangle className="w-4 h-4 shrink-0" />
     </div>
   ) : undefined
 }
 placeholder={m.placeholder_repo_url()}
 />

 <AnimatePresence>
   {scoutError && !loading && !isReauthorizing && (
     <motion.div
       initial={{ opacity: 0, height: 0, y: -4 }}
       animate={{ opacity: 1, height: 'auto', y: 0 }}
       exit={{ opacity: 0, height: 0, y: -4 }}
       transition={{ duration: 0.2, ease: 'easeOut' }}
       className="overflow-hidden text-left"
     >
       <Alert 
         variant="error" 
         className="py-2.5 px-3.5 rounded-xl border border-theme-border/60 bg-theme-surface text-xs flex items-center justify-between gap-2 shadow-2xs"
       >
         <div className="flex items-center gap-2 min-w-0">
           <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
           <span className="text-theme-foreground font-medium text-xs truncate">
             {scoutError.status === 'NOT_FOUND'
               ? m.step1_error_not_found()
               : scoutError.status === 'AUTH_REQUIRED'
               ? m.toast_login_required()
               : scoutError.status === 'RATE_LIMITED'
               ? m.step1_error_rate_limited()
               : scoutError.status === 'UNSUPPORTED_DOMAIN'
               ? m.step1_error_unsupported_domain()
               : scoutError.error || m.step1_error_invalid_url_retry()}
           </span>
         </div>

         {scoutError.status === 'AUTH_REQUIRED' && (
           <button
             type="button"
             onClick={handleAuthRequired}
             className="shrink-0 px-2.5 py-1 bg-theme-primary text-theme-primary-fg text-xs font-bold rounded-lg hover:opacity-90 transition-opacity cursor-pointer"
           >{m.common_signin()}</button>
         )}
       </Alert>
     </motion.div>
   )}
 </AnimatePresence>

  <AnimatePresence>
  {hasUrlInput && !liveIsWebUrl && !loading && (
  <motion.div
  initial={{ opacity: 0, height: 0, y: -6 }}
  animate={{ opacity: 1, height: 'auto', y: 0 }}
  exit={{ opacity: 0, height: 0, y: -6 }}
  transition={{ duration: 0.25, ease: 'easeInOut' }}
  className="overflow-hidden space-y-2.5"
  >
  <div className="flex items-center justify-between px-3.5 py-2 bg-theme-surface/80 border border-theme-border/60 rounded-xl text-left shadow-2xs">
  <div className="flex items-center gap-2">
  <Globe size={14} className="text-theme-primary shrink-0" />
  <span className="text-xs font-serif font-medium text-theme-foreground">
  {m.language_preference()}
  </span>
  </div>

  <div className="flex items-center gap-1.5">
  <Languages size={13} className="text-theme-muted shrink-0" />
  <Select
  value={targetLanguage}
  onValueChange={(val) => {
    if (val) wizardFlow.updateTargetLanguage(val);
  }}
  disabled={loading}
  >
  <SelectTrigger className="w-auto h-7 px-2.5 text-xs font-serif font-bold text-theme-primary bg-theme-bg/60 border border-theme-border/50 hover:bg-theme-primary/10 rounded-lg flex items-center gap-1.5 cursor-pointer outline-none transition-colors">
  <SelectValue>
  {SUPPORTED_LANGUAGES.find((l) => l.code === targetLanguage)?.nativeName ||
    SUPPORTED_LANGUAGES.find((l) => l.code === targetLanguage)?.name ||
    targetLanguage}
  </SelectValue>
  </SelectTrigger>
  <SelectContent className="bg-theme-surface border border-theme-border/70 font-serif max-h-60 z-50">
  {SUPPORTED_LANGUAGES.map((lang) => (
  <SelectItem key={lang.code} value={lang.code} className="text-xs font-serif cursor-pointer hover:bg-theme-primary/10">
    {lang.nativeName || lang.name}
  </SelectItem>
  ))}
  </SelectContent>
  </Select>
  </div>
  </div>

  <div className="flex items-center justify-between px-3.5 py-2 bg-theme-surface/80 border border-theme-border/60 rounded-xl text-left shadow-2xs">
    <div className="flex items-center gap-2">
      <Sparkles size={14} className="text-theme-primary shrink-0" />
      <span className="text-xs font-serif font-medium text-theme-foreground">
        {m.import_model_preference()}
      </span>
    </div>

    <WizardModelSelector variant="card" disabled={loading} />
  </div>

  <div className="p-3 bg-theme-surface/80 border border-theme-border/60 rounded-xl text-left shadow-2xs space-y-2">
    <div className="flex items-center justify-between gap-2 flex-wrap sm:flex-nowrap">
      <div className="flex items-center gap-2 shrink-0">
        <GraduationCap size={14} className="text-theme-primary shrink-0" />
        <span className="text-xs font-serif font-medium text-theme-foreground">
          {m.import_depth_preference()}
        </span>
      </div>

      <div className="inline-flex items-center bg-theme-bg/60 p-0.5 rounded-lg border border-theme-border/50 gap-0.5 shrink-0">
        {depthOptions.map((opt) => {
          const isActive = activeDepthKey === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              disabled={loading}
              title={opt.tip}
              onClick={() => handleDepthSelect(opt.key)}
              className={cn(
                "px-2.5 py-0.5 text-xs font-serif transition-all cursor-pointer disabled:cursor-not-allowed select-none rounded-md",
                isActive
                  ? "bg-theme-surface text-theme-primary font-bold shadow-2xs border border-theme-border/60"
                  : "text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/50 border border-transparent"
              )}
            >
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>
    </div>

    <AnimatePresence>
      {isCustomMode && (
        <motion.div
          initial={{ opacity: 0, height: 0, y: -4 }}
          animate={{ opacity: 1, height: 'auto', y: 0 }}
          exit={{ opacity: 0, height: 0, y: -4 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="overflow-hidden pt-0.5"
        >
          <div className="relative">
            <textarea
              value={customPrompt}
              onChange={(e) => {
                lastCustomPromptRef.current = e.target.value;
                setCustomPrompt(e.target.value);
              }}
              disabled={loading}
              rows={2}
              placeholder={m.import_depth_custom_placeholder()}
              className="w-full text-caption font-sans bg-theme-bg/60 border border-theme-border/60 rounded-lg p-2.5 pr-16 resize-none outline-none focus:border-theme-primary/60 text-theme-foreground custom-scrollbar placeholder:text-theme-muted/50 leading-relaxed transition-colors"
            />
            {customPrompt && (
              <button
                type="button"
                disabled={loading}
                onClick={() => {
                  lastCustomPromptRef.current = '';
                  setCustomPrompt('');
                }}
                className="absolute top-2 right-2 text-micro text-theme-muted hover:text-rose-500 font-sans cursor-pointer transition-colors"
              >
                {m.workbench_editor_clear_prompt()}
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  </div>

  <div className="flex items-start justify-between px-3.5 py-2.5 bg-theme-surface/80 border border-theme-border/60 rounded-xl text-left shadow-2xs">
    <div className="flex items-start gap-2.5 min-w-0 flex-1">
      <Checkbox
        id="step1-public-checkbox"
        checked={isPublic}
        onCheckedChange={(checked) => setIsPublic(Boolean(checked))}
        className="mt-0.5 border-theme-border data-checked:bg-theme-primary data-checked:border-theme-primary text-theme-primary-fg shrink-0 cursor-pointer"
      />
      <div className="flex flex-col select-none min-w-0 flex-1">
        <label
          htmlFor="step1-public-checkbox"
          className="text-xs font-serif font-medium text-theme-foreground cursor-pointer flex items-center gap-1.5"
        >
          <span>{m.step1_public_label()}</span>
        </label>
        <div className="text-caption font-sans text-theme-muted mt-0.5 flex items-center gap-0.5 flex-wrap leading-relaxed">
          {isPublic ? (
            <>
              <span>{m.step1_public_desc_prefix()}</span>
              <CreditsRulesPopover />
              {m.step1_public_desc_suffix() ? <span>{m.step1_public_desc_suffix()}</span> : null}
            </>
          ) : (
            <>
              <span>{m.step1_private_desc_prefix()}</span>
              <CreditsRulesPopover />
              {m.step1_private_desc_suffix() ? <span>{m.step1_private_desc_suffix()}</span> : null}
            </>
          )}
        </div>
      </div>
    </div>
  </div>
  </motion.div>
  )}
  </AnimatePresence>

        {loading && scoutSteps.length > 0 ? (
          <ScoutPipelineViewer displayedCount={displayedCount} scoutSteps={scoutSteps} />
        ) : (
          <button
            type="button"
            onClick={() => handleScout()}
            disabled={!hasUrlInput || loading || isReauthorizing}
            className={cn(
              "w-full py-2.5 text-xs font-serif font-bold tracking-[0.15em] rounded-lg transition-all flex items-center justify-center gap-2 shadow-sm",
              !hasUrlInput || loading || isReauthorizing
                ? "bg-theme-surface/80 text-theme-muted border border-theme-border/60 opacity-60 cursor-not-allowed"
                : "bg-theme-primary text-theme-primary-fg hover:opacity-90 active:scale-[0.98] cursor-pointer"
            )}
          >
            {isReauthorizing ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                <span>{m.import_reauthorizing_github()}</span>
              </>
            ) : loading ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                <span>{m.import_detecting_btn()}</span>
              </>
            ) : (
              <span>
                {liveIsWebUrl
                  ? m.webdoc_step1_next_scout()
                  : hasCachedGithubScout
                    ? m.dashboard_continue()
                    : m.import_start_btn()}
              </span>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
