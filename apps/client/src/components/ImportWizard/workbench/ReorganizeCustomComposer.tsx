'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { api } from '@/lib/api/client';
import { useImportWizardStore } from '@/lib/stores/import-wizard-store';
import { useModalStore } from '@/lib/stores/modal-store';
import { UpstreamErrorNotice } from '@/components/common/UpstreamErrorNotice';
import { resolveUpstreamErrorPresentation } from '@/lib/llm-gateway/upstream-error-ui';
import type { ReorganizeCategoryIntent } from '@/lib/constants';
import * as m from '@/paraglide/messages';
import type { WorkbenchOutlineCategory } from './editor/OutlineCategoryBlock';
import { shouldShowAiExpand } from './ai-expand-eligibility';

const SAVE_LABEL_MAX_LENGTH = 48;

const CARET_IDLE_DELAY_MS = 550;
const FLOATING_PILL_ESTIMATED_WIDTH = 84;
const FLOATING_PILL_HEIGHT = 24;
const TEXTAREA_SHARED_TYPOGRAPHY =
  'w-full text-xs font-sans leading-relaxed px-2.5 py-2 border';

export interface ReorganizeCustomComposerProps {
  categoryIntent?: ReorganizeCategoryIntent;
  initialInput?: string;
  autoFocus?: boolean;
  placeholder?: string;
  submitLabel?: string;
  rows?: number;
  onSubmit: (prompt: string) => void;
  onSaveAndUse?: (label: string, prompt: string) => void;
}

export function ReorganizeCustomComposer({
  categoryIntent,
  initialInput,
  autoFocus = true,
  placeholder,
  submitLabel,
  rows = 3,
  onSubmit,
  onSaveAndUse,
}: ReorganizeCustomComposerProps): React.JSX.Element {
  const customOutline = useImportWizardStore((s) => s.customOutline);
  const scoutData = useImportWizardStore((s) => s.scoutData);
  const category = useImportWizardStore((s) => s.category);
  const selectedTags = useImportWizardStore((s) => s.selectedTags);
  const selectedPrefix = useImportWizardStore((s) => s.selectedPrefix);
  const targetLanguage = useImportWizardStore((s) => s.targetLanguage);

  const [customInput, setCustomInput] = useState(() => initialInput ?? '');
  const [expandedDraft, setExpandedDraft] = useState<string | null>(null);
  const [expandedLabel, setExpandedLabel] = useState('');
  const [lastExpandedPrompt, setLastExpandedPrompt] = useState('');
  const [draftBeforeAdopt, setDraftBeforeAdopt] = useState<string | null>(null);
  const [isExpanding, setIsExpanding] = useState(false);
  const [expandError, setExpandError] = useState<unknown>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [caretIndex, setCaretIndex] = useState(() => (initialInput ?? '').length);
  const [showFloatingExpand, setShowFloatingExpand] = useState(false);
  const [floatingPos, setFloatingPos] = useState<{ top: number; left: number } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const caretMarkerRef = useRef<HTMLSpanElement | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isComposingRef = useRef(false);
  const expandAbortRef = useRef<AbortController | null>(null);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const evaluateExpandEligibility = useCallback(
    (overrideText?: string, overrideSelectionLen?: number) => {
      const el = textareaRef.current;
      const text = overrideText ?? el?.value ?? customInput;
      const selectionLength =
        overrideSelectionLen ??
        (el ? Math.max(0, (el.selectionEnd ?? 0) - (el.selectionStart ?? 0)) : 0);

      return shouldShowAiExpand({
        text,
        selectionLength,
        isComposing: isComposingRef.current,
        isExpanding,
        hasExpandedDraft: expandedDraft !== null,
        lastExpandedPrompt,
        hasOutline: customOutline.length > 0,
      });
    },
    [customInput, customOutline.length, expandedDraft, isExpanding, lastExpandedPrompt]
  );

  const scheduleIdleExpand = useCallback(
    (overrideText?: string, overrideSelectionLen?: number) => {
      clearIdleTimer();
      setShowFloatingExpand(false);
      if (!evaluateExpandEligibility(overrideText, overrideSelectionLen)) {
        return;
      }
      idleTimerRef.current = setTimeout(() => {
        idleTimerRef.current = null;
        if (evaluateExpandEligibility()) {
          setShowFloatingExpand(true);
        }
      }, CARET_IDLE_DELAY_MS);
    },
    [clearIdleTimer, evaluateExpandEligibility]
  );

  const syncCaretAndSchedule = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      setCaretIndex(el.selectionStart ?? customInput.length);
      scheduleIdleExpand(el.value, Math.max(0, (el.selectionEnd ?? 0) - (el.selectionStart ?? 0)));
      return;
    }
    scheduleIdleExpand();
  }, [customInput.length, scheduleIdleExpand]);

  useEffect(() => {
    return () => {
      clearIdleTimer();
      expandAbortRef.current?.abort();
    };
  }, [clearIdleTimer]);

  useEffect(() => {
    if (!isFocused || !evaluateExpandEligibility()) {
      clearIdleTimer();
      setShowFloatingExpand(false);
    }
  }, [clearIdleTimer, evaluateExpandEligibility, isFocused]);

  useLayoutEffect(() => {
    if (!showFloatingExpand) {
      setFloatingPos(null);
      return;
    }
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    const marker = caretMarkerRef.current;
    if (!textarea || !mirror || !marker) {
      setFloatingPos(null);
      return;
    }

    const clientWidth = textarea.clientWidth;
    const clientHeight = textarea.clientHeight;
    if (clientWidth === 0 || clientHeight === 0) {
      setFloatingPos(null);
      return;
    }

    if (customInput.length === 0) {
      setFloatingPos({
        top: Math.max(6, clientHeight - FLOATING_PILL_HEIGHT - 6),
        left: Math.max(8, clientWidth - FLOATING_PILL_ESTIMATED_WIDTH - 8),
      });
      return;
    }

    mirror.style.width = `${clientWidth}px`;
    const caretTop = marker.offsetTop - textarea.scrollTop;
    const caretLeft = marker.offsetLeft - textarea.scrollLeft;
    const lineHeight = marker.offsetHeight || 18;

    if (caretTop < 0 || caretTop > clientHeight - 4) {
      setFloatingPos(null);
      return;
    }

    const inlineLeft = caretLeft + 8;
    if (inlineLeft + FLOATING_PILL_ESTIMATED_WIDTH <= clientWidth - 6) {
      setFloatingPos({
        top: Math.max(
          4,
          Math.min(
            caretTop + (lineHeight - FLOATING_PILL_HEIGHT) / 2,
            clientHeight - FLOATING_PILL_HEIGHT - 4,
          ),
        ),
        left: inlineLeft,
      });
      return;
    }

    const belowTop = caretTop + lineHeight + 4;
    const top =
      belowTop + FLOATING_PILL_HEIGHT <= clientHeight - 4
        ? belowTop
        : Math.max(4, caretTop - FLOATING_PILL_HEIGHT - 4);
    const left = Math.max(6, Math.min(caretLeft, clientWidth - FLOATING_PILL_ESTIMATED_WIDTH - 6));
    setFloatingPos({ top, left });
  }, [caretIndex, customInput, showFloatingExpand]);

  const handleAiExpand = async () => {
    if (isExpanding || customOutline.length === 0) return;

    expandAbortRef.current?.abort();
    const controller = new AbortController();
    expandAbortRef.current = controller;

    setIsExpanding(true);
    setExpandedDraft(null);
    setExpandError(null);

    try {
      const outlinePayload = (customOutline as WorkbenchOutlineCategory[])
        .slice(0, 60)
        .map((cat) => ({
          partTitle: cat.partTitle ? cat.partTitle.slice(0, 150) : undefined,
          title: (cat.title || cat.name || '').slice(0, 200),
          files: Array.isArray(cat.files)
            ? cat.files
                .map((file) => (file.path || file.shortTitle || '').slice(0, 300))
                .filter(Boolean)
                .slice(0, 8)
            : [],
        }))
        .filter((cat) => cat.title.length > 0);

      const repoSlug =
        scoutData?.owner && scoutData?.repo ? `${scoutData.owner}/${scoutData.repo}` : '';

      const data = await api.post<{
        ok: boolean;
        shortLabel?: string;
        expandedPrompt: string;
      }>(
        '/api/ai/expand-outline-prompt',
        {
          userInput: customInput.slice(0, 1000),
          repoSlug: repoSlug.slice(0, 200),
          domain: (category || '').slice(0, 100),
          tags: selectedTags.slice(0, 20).map((t) => t.slice(0, 60)),
          scopePrefix: (selectedPrefix || '').slice(0, 300),
          targetLanguage,
          outline: outlinePayload,
          categoryIntent: categoryIntent ?? 'general',
        },
        {
          signal: controller.signal,
          toastOnError: false,
        },
      );

      if (!data?.expandedPrompt) {
        setExpandError(new Error(m.workbench_reorganize_expand_failed()));
        return;
      }

      const expanded = data.expandedPrompt.trim();
      setExpandedDraft(expanded);
      setExpandedLabel(data.shortLabel?.trim() || '');
      setLastExpandedPrompt(expanded);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      console.warn('[ReorganizeCustomComposer] AI expand failed:', err);
      setExpandError(err ?? new Error(m.workbench_reorganize_expand_failed()));
    } finally {
      if (expandAbortRef.current === controller) {
        setIsExpanding(false);
      }
    }
  };

  const handleAdoptExpanded = () => {
    if (!expandedDraft) return;
    setDraftBeforeAdopt(customInput);
    setCustomInput(expandedDraft);
    setExpandedDraft(null);
    setExpandError(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  };

  const handleDiscardExpanded = () => {
    setExpandedDraft(null);
    setExpandError(null);
  };

  const handleRestoreDraft = () => {
    if (draftBeforeAdopt === null) return;
    setCustomInput(draftBeforeAdopt);
    setDraftBeforeAdopt(null);
    setExpandError(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  };

  const resetExpansionUi = () => {
    setExpandedDraft(null);
    setDraftBeforeAdopt(null);
    setExpandError(null);
    setExpandedLabel('');
    setLastExpandedPrompt('');
  };

  const handleSubmit = () => {
    if (isExpanding) return;
    const pendingExpanded = expandedDraft?.trim();
    if (pendingExpanded) {
      resetExpansionUi();
      onSubmit(pendingExpanded);
      return;
    }
    const trimmed = customInput.trim();
    if (!trimmed) return;
    resetExpansionUi();
    onSubmit(trimmed);
  };

  const deriveSaveLabel = (trimmed: string): string => {
    if (trimmed && trimmed === lastExpandedPrompt && expandedLabel) {
      return expandedLabel;
    }
    return trimmed.slice(0, SAVE_LABEL_MAX_LENGTH);
  };

  const handleSaveAndUse = () => {
    if (!onSaveAndUse || isExpanding) return;
    const trimmed = customInput.trim();
    if (!trimmed) return;
    resetExpansionUi();
    onSaveAndUse(deriveSaveLabel(trimmed), trimmed);
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="relative">
        <div
          ref={mirrorRef}
          aria-hidden="true"
          className={`${TEXTAREA_SHARED_TYPOGRAPHY} border-transparent pointer-events-none invisible absolute inset-0 overflow-hidden whitespace-pre-wrap break-words`}
        >
          <span>{customInput.slice(0, caretIndex)}</span>
          <span ref={caretMarkerRef} className="inline-block w-0 align-baseline">
            {'\u200b'}
          </span>
        </div>

        <textarea
          ref={textareaRef}
          autoFocus={autoFocus}
          rows={rows}
          disabled={isExpanding}
          value={customInput}
          onFocus={() => {
            setIsFocused(true);
            syncCaretAndSchedule();
          }}
          onBlur={() => {
            setIsFocused(false);
            clearIdleTimer();
            setShowFloatingExpand(false);
          }}
          onCompositionStart={() => {
            isComposingRef.current = true;
            clearIdleTimer();
            setShowFloatingExpand(false);
          }}
          onCompositionEnd={(e) => {
            isComposingRef.current = false;
            const el = e.currentTarget;
            setCaretIndex(el.selectionStart ?? el.value.length);
            scheduleIdleExpand(el.value, Math.max(0, (el.selectionEnd ?? 0) - (el.selectionStart ?? 0)));
          }}
          onChange={(e) => {
            const el = e.currentTarget;
            setCustomInput(el.value);
            setCaretIndex(el.selectionStart ?? el.value.length);
            scheduleIdleExpand(el.value, Math.max(0, (el.selectionEnd ?? 0) - (el.selectionStart ?? 0)));
          }}
          onClick={syncCaretAndSchedule}
          onKeyUp={(e) => {
            if (e.key === 'Escape' || e.key === 'Enter') return;
            syncCaretAndSchedule();
          }}
          onScroll={() => {
            if (showFloatingExpand) {
              setShowFloatingExpand(false);
              scheduleIdleExpand();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && showFloatingExpand) {
              e.preventDefault();
              e.stopPropagation();
              clearIdleTimer();
              setShowFloatingExpand(false);
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={placeholder ?? m.workbench_reorganize_input_placeholder()}
          className={`${TEXTAREA_SHARED_TYPOGRAPHY} resize-none bg-theme-surface/60 border-theme-border/70 rounded-lg text-theme-foreground placeholder:text-theme-muted/60 focus:outline-none focus:border-theme-primary transition-colors disabled:opacity-50`}
        />

        {showFloatingExpand &&
          floatingPos &&
          !isExpanding &&
          expandedDraft === null &&
          customOutline.length > 0 && (
            <button
              type="button"
              style={{ top: `${floatingPos.top}px`, left: `${floatingPos.left}px` }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                clearIdleTimer();
                setShowFloatingExpand(false);
                void handleAiExpand();
              }}
              className="absolute z-10 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-micro font-medium border border-theme-primary/40 bg-theme-bg/95 text-theme-primary shadow-sm backdrop-blur-xs hover:bg-theme-primary/15 hover:border-theme-primary/60 active:scale-95 transition-all cursor-pointer animate-in fade-in zoom-in-95 duration-150"
            >
              <Sparkles size={11} className="shrink-0" />
              <span>{m.workbench_reorganize_ai_expand()}</span>
            </button>
          )}

        {isExpanding && (
          <div
            aria-busy="true"
            className="absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-lg bg-theme-bg/80 backdrop-blur-[1px] border border-theme-primary/30 text-xs font-sans text-theme-foreground select-none animate-in fade-in duration-150"
          >
            <Loader2 size={14} className="animate-spin text-theme-primary shrink-0" />
            <span>{m.workbench_reorganize_ai_expanding()}</span>
          </div>
        )}
      </div>

      {expandedDraft !== null && (
        <div className="rounded-lg border border-theme-primary/30 bg-theme-surface/70 p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              {onSaveAndUse && expandedLabel && (
                <span className="text-micro text-theme-primary border border-theme-primary/30 bg-theme-primary/10 rounded-full px-2 py-0.5">
                  {m.workbench_reorganize_short_label_preview()}: {expandedLabel}
                </span>
              )}
              <span className="text-micro font-medium text-theme-primary">
                {m.workbench_reorganize_expand_preview_label()}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleDiscardExpanded}
                className="px-2 py-0.5 text-micro font-sans rounded-md text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-colors cursor-pointer"
              >
                {m.workbench_reorganize_expand_discard()}
              </button>
              <button
                type="button"
                onClick={handleAdoptExpanded}
                className="px-2.5 py-0.5 text-micro font-medium rounded-md border border-theme-primary/40 bg-theme-primary/15 text-theme-primary hover:bg-theme-primary/25 transition-colors cursor-pointer"
              >
                {m.workbench_reorganize_expand_adopt()}
              </button>
            </div>
          </div>
          <p className="text-xs font-sans leading-relaxed text-theme-foreground whitespace-pre-wrap">
            {expandedDraft}
          </p>
        </div>
      )}

      {Boolean(expandError) && (() => {
        const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
        const retryExpand = () => {
          void handleAiExpand();
        };
        return (
          <UpstreamErrorNotice
            variant="inline"
            isOffline={isOffline}
            error={resolveUpstreamErrorPresentation(expandError, {
              offline: isOffline,
              fallbackTitle: m.workbench_reorganize_expand_failed(),
              fallbackDesc: m.common_retry_later(),
            })}
            onRetry={retryExpand}
            onModelSwitched={retryExpand}
            onOpenPreferencesModal={() => useModalStore.getState().openPreferencesModal('llm')}
            onOpenApiKeyModal={() =>
              useModalStore.getState().openApiKeyModal({
                onCompleted: retryExpand,
              })
            }
          />
        );
      })()}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {draftBeforeAdopt !== null && (
            <button
              type="button"
              disabled={isExpanding}
              onClick={handleRestoreDraft}
              className="px-2 py-1.5 text-xs font-sans rounded-lg text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/60 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {m.workbench_reorganize_expand_restore()}
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {onSaveAndUse && (
            <button
              type="button"
              disabled={isExpanding || !customInput.trim()}
              onClick={handleSaveAndUse}
              className="px-2.5 py-1.5 text-xs font-sans rounded-lg border border-theme-border/70 bg-theme-surface/50 text-theme-muted hover:text-theme-foreground hover:border-theme-border hover:bg-theme-surface transition-all cursor-pointer active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              {m.workbench_reorganize_save_use()}
            </button>
          )}
          <button
            type="button"
            disabled={isExpanding || (!customInput.trim() && expandedDraft === null)}
            onClick={handleSubmit}
            className="px-3.5 py-1.5 bg-theme-primary text-theme-primary-fg font-serif font-medium text-xs rounded-lg hover:opacity-90 active:scale-95 transition-all shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitLabel ?? m.workbench_reorganize_submit()}
          </button>
        </div>
      </div>
    </div>
  );
}
