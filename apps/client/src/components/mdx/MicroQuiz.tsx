'use client';

import { useState, useEffect, useMemo, useId } from 'react';
import {
  Target,
  CheckCircle2,
  XCircle,
  Sparkles,
  BookOpen,
  Layers,
  Flame,
  Play,
  ChevronDown,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import * as m from '@/paraglide/messages';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Popover,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
  PopoverClose,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

import { useQuizSession, type QuizQuestion, type QuizSession, type Difficulty, type TargetDifficulty } from './useQuizSession';
import { STORAGE_KEYS } from '@/lib/constants';
import { useSettingsStore } from '@/lib/stores/settings-store';
import { useModalStore } from '@/lib/stores/modal-store';
import { getModelThinkingCapability } from '@/lib/llm-gateway/thinking-adapter';
import { UpstreamErrorNotice } from '@/components/common/UpstreamErrorNotice';
import { resolveUpstreamErrorPresentation } from '@/lib/llm-gateway/upstream-error-ui';

export type { QuizQuestion, QuizSession };

export default function MicroQuiz({
  documentId,
  contentId,
}: {
  documentId: string;
  contentId: string | null;
}) {
  const {
    currentSession,
    loading,
    error,
    errorInfo,
    allSubmitted,
    hasAnySessionStarted,
    resetCurrentSession,
    fetchQuiz,
    handleSelect,
    handleSubmit,
    handleRetryQuestion,
  } = useQuizSession({ documentId, contentId });

  const [selectedDifficulty, setSelectedDifficulty] = useState<TargetDifficulty>('adaptive');
  const [diffPopoverOpen, setDiffPopoverOpen] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [confirmDismissed, setConfirmDismissed] = useState(false);
  const [showConfirmPopover, setShowConfirmPopover] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const dontAskCheckboxId = useId();

  const activeModel = useSettingsStore((s) => s.model);
  const activeProvider = useSettingsStore((s) => s.provider);
  const thinkingCap = useMemo(
    () => getModelThinkingCapability(activeModel, activeProvider),
    [activeModel, activeProvider]
  );

  const effectiveThinking =
    thinkingCap.type === 'thinking-only'
      ? true
      : thinkingCap.type === 'non-thinking'
        ? false
        : isThinking;

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setIsThinking(localStorage.getItem(STORAGE_KEYS.QUIZ_ENABLE_THINKING) === 'true');
      setConfirmDismissed(localStorage.getItem(STORAGE_KEYS.QUIZ_TOKEN_CONFIRM_DISMISSED) === 'true');
      const savedDiff = localStorage.getItem(STORAGE_KEYS.QUIZ_DIFFICULTY) as TargetDifficulty | null;
      if (savedDiff && ['adaptive', 'easy', 'medium', 'hard'].includes(savedDiff)) {
        setSelectedDifficulty(savedDiff);
      }
    }
  }, []);

  const handleDifficultyChange = (diff: TargetDifficulty) => {
    setSelectedDifficulty(diff);
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.QUIZ_DIFFICULTY, diff);
    }
  };

  const handleThinkingChange = (checked: boolean) => {
    setIsThinking(checked);
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.QUIZ_ENABLE_THINKING, String(checked));
    }
  };

  const startQuizNow = () => {
    fetchQuiz(selectedDifficulty === 'adaptive' ? undefined : selectedDifficulty, effectiveThinking);
  };

  const handleConfirmOpenChange = (nextOpen: boolean) => {
    if (nextOpen && confirmDismissed) {
      startQuizNow();
      return;
    }
    setShowConfirmPopover(nextOpen);
    if (!nextOpen) {
      setDontAskAgain(false);
    }
  };

  const handleConfirmStart = () => {
    if (dontAskAgain && typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.QUIZ_TOKEN_CONFIRM_DISMISSED, 'true');
      setConfirmDismissed(true);
    }
    setShowConfirmPopover(false);
    setDontAskAgain(false);
    startQuizNow();
  };

  const selectedDiffLabel =
    selectedDifficulty === 'easy'
      ? m.diff_easy()
      : selectedDifficulty === 'medium'
      ? m.diff_medium()
      : selectedDifficulty === 'hard'
      ? m.diff_hard()
      : m.diff_adaptive();

  if (loading) {
    return (
      <div className="warm-theme-primary my-8 rounded-2xl border border-theme-primary/30 bg-theme-primary/10 overflow-hidden animate-pulse">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-theme-primary/30 bg-theme-primary/10">
          <Skeleton className="w-5 h-5 rounded-full bg-theme-primary/10" />
          <Skeleton className="w-28 h-4 bg-theme-primary/10" />
        </div>

        <div className="p-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <Skeleton className="w-3/4 h-5 bg-theme-bg/85" />
              <Skeleton className="w-1/2 h-4 bg-theme-bg/60" />
            </div>

            <div className="space-y-2">
              {[1, 2, 3, 4].map((j) => (
                <div key={j} className="w-full flex items-center px-4 py-3 rounded-xl border border-theme-border/60 bg-theme-surface/50 h-12">
                  <Skeleton className="w-1/3 h-4 bg-theme-bg/80" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error || errorInfo) {
    const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
    const retryQuiz = () => {
      void fetchQuiz(
        selectedDifficulty === 'adaptive' ? undefined : selectedDifficulty,
        effectiveThinking
      );
    };
    const errorPresentation = resolveUpstreamErrorPresentation(
      errorInfo ?? error ?? m.quiz_fetch_failed(),
      {
        offline: isOffline,
        fallbackTitle: m.quiz_fallback_error_title(),
        fallbackDesc: error ?? m.quiz_fetch_failed(),
      }
    );

    return (
      <div className="warm-theme-primary my-8">
        <UpstreamErrorNotice
          variant="card"
          isOffline={isOffline}
          error={errorPresentation}
          onRetry={retryQuiz}
          retryLabel={m.quiz_retry()}
          onModelSwitched={retryQuiz}
          onOpenPreferencesModal={() => useModalStore.getState().openPreferencesModal('llm')}
          onOpenApiKeyModal={() =>
            useModalStore.getState().openApiKeyModal({
              contextText:
                errorPresentation.code === 'KEY_DECRYPT_FAILED'
                  ? m.toast_key_decrypt_failed_desc()
                  : m.toast_missing_api_key(),
              onCompleted: retryQuiz,
            })
          }
        />
      </div>
    );
  }

  if (!hasAnySessionStarted) {
    const startButtonClassName =
      'px-7 py-2.5 rounded-full bg-theme-primary text-theme-primary-fg text-sm font-semibold shadow-md hover:shadow-lg hover:opacity-90 transition-all cursor-pointer flex items-center gap-2 active:scale-95';

    return (
      <div className="warm-theme-primary my-8 p-8 rounded-2xl border border-theme-border bg-theme-bg flex flex-col items-center justify-center text-center gap-6 select-none">
        <div className="w-12 h-12 bg-theme-primary/10 border border-theme-primary/30 flex items-center justify-center rounded-2xl shadow-sm text-theme-primary">
          <Target size={24} className="animate-pulse" />
        </div>

        <div className="space-y-1.5">
          <h3 className="text-base font-serif font-bold text-theme-foreground">{m.quiz_quiz_title()}</h3>
          <p className="text-xs text-theme-muted max-w-md leading-relaxed">
            {m.quiz_quiz_locked()}
          </p>
        </div>

        <div className="flex flex-col items-center gap-3 select-none">
          {confirmDismissed ? (
            <button
              type="button"
              onClick={startQuizNow}
              className={startButtonClassName}
            >
              <Play size={13} className="fill-current" />
              <span>{m.quiz_start()}</span>
            </button>
          ) : (
            <Popover open={showConfirmPopover} onOpenChange={handleConfirmOpenChange}>
              <PopoverTrigger type="button" className={startButtonClassName}>
                <Play size={13} className="fill-current" />
                <span>{m.quiz_start()}</span>
              </PopoverTrigger>

              <PopoverPopup
                side="top"
                align="center"
                sideOffset={10}
                collisionPadding={12}
                className="w-[min(21.5rem,calc(100vw-2rem))] rounded-2xl bg-theme-surface border border-theme-border shadow-xl text-theme-foreground text-left select-none duration-150 data-ending-style:scale-98 data-ending-style:opacity-0"
                viewportClassName="px-4 py-3.5"
              >
                <PopoverTitle className="font-serif font-semibold text-sm text-theme-foreground leading-snug">
                  {m.quiz_confirm_title()}
                </PopoverTitle>
                <PopoverDescription className="mt-1.5 font-sans text-xs text-theme-muted leading-relaxed">
                  {m.quiz_confirm_desc()}
                </PopoverDescription>
                {effectiveThinking && (
                  <p className="mt-1.5 font-sans text-xs text-theme-muted leading-relaxed">
                    {m.quiz_confirm_desc_thinking()}
                  </p>
                )}

                <div className="mt-3.5 pt-3 border-t border-theme-border/50 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 font-sans">
                  <label
                    htmlFor={dontAskCheckboxId}
                    className="flex items-center gap-1.5 cursor-pointer select-none text-xs text-theme-muted hover:text-theme-foreground transition-colors"
                  >
                    <Checkbox
                      id={dontAskCheckboxId}
                      checked={dontAskAgain}
                      onCheckedChange={(checked) => setDontAskAgain(Boolean(checked))}
                      className="size-3.5 border-theme-border data-checked:bg-theme-primary data-checked:border-theme-primary text-theme-primary-fg shrink-0 cursor-pointer"
                    />
                    <span>{m.quiz_dont_ask_again()}</span>
                  </label>

                  <div className="flex items-center gap-2 ml-auto">
                    <PopoverClose
                      type="button"
                      className="px-3 py-1 text-xs rounded-full text-theme-muted hover:text-theme-foreground hover:bg-theme-bg transition-colors cursor-pointer border border-theme-border"
                    >
                      {m.common_cancel()}
                    </PopoverClose>
                    <button
                      type="button"
                      onClick={handleConfirmStart}
                      className="px-3.5 py-1 text-xs rounded-full transition-all font-medium cursor-pointer bg-theme-primary hover:opacity-90 text-theme-primary-fg shadow-sm active:scale-95"
                    >
                      {m.quiz_start()}
                    </button>
                  </div>
                </div>
              </PopoverPopup>
            </Popover>
          )}

          <div className="flex items-center justify-center gap-4">
            <Popover open={diffPopoverOpen} onOpenChange={setDiffPopoverOpen}>
              <PopoverTrigger
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-theme-border/60 bg-theme-surface/50 hover:bg-theme-surface text-micro text-theme-muted hover:text-theme-foreground transition-all cursor-pointer select-none"
                aria-label={m.quiz_difficulty_label()}
              >
                <span>{m.quiz_difficulty_short()}</span>
                <span className="opacity-40">·</span>
                <span className="font-medium text-theme-foreground">{selectedDiffLabel}</span>
                <ChevronDown size={11} className="opacity-50" />
              </PopoverTrigger>

              <PopoverPopup
                side="bottom"
                align="center"
                sideOffset={6}
                className="p-1 rounded-xl bg-theme-bg border border-theme-border shadow-xl text-theme-foreground font-sans z-[9999] min-w-28 overflow-hidden animate-in fade-in zoom-in-95 duration-100"
              >
                <div className="flex flex-col gap-0.5">
                  {(
                    [
                      { value: 'adaptive' as const, label: m.diff_adaptive(), icon: Sparkles },
                      { value: 'easy' as const, label: m.diff_easy(), icon: BookOpen },
                      { value: 'medium' as const, label: m.diff_medium(), icon: Layers },
                      { value: 'hard' as const, label: m.diff_hard(), icon: Flame },
                    ] as const
                  ).map((opt) => {
                    const isSelected = selectedDifficulty === opt.value;
                    const Icon = opt.icon;
                    return (
                      <button
                        key={opt.value}
                        onClick={() => {
                          handleDifficultyChange(opt.value);
                          setDiffPopoverOpen(false);
                        }}
                        className={cn(
                          'flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-micro transition-colors cursor-pointer text-left w-full',
                          isSelected
                            ? 'bg-theme-surface font-semibold text-theme-primary'
                            : 'text-theme-foreground hover:bg-theme-surface/70'
                        )}
                      >
                        <Icon size={12} className={isSelected ? 'text-theme-primary' : 'text-theme-muted'} />
                        <span>{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
              </PopoverPopup>
            </Popover>

            <label
              className={cn(
                'flex items-center gap-1.5 text-micro select-none transition-colors',
                thinkingCap.type !== 'thinking-optional'
                  ? 'cursor-default text-theme-muted opacity-80'
                  : 'cursor-pointer text-theme-muted hover:text-theme-foreground'
              )}
              title={
                thinkingCap.type === 'thinking-only'
                  ? m.quiz_thinking_only_desc()
                  : thinkingCap.type === 'non-thinking'
                    ? m.quiz_thinking_non_desc()
                    : isThinking
                      ? m.quiz_thinking_warning()
                      : m.quiz_thinking_hint()
              }
            >
              <Checkbox
                checked={effectiveThinking}
                disabled={thinkingCap.type !== 'thinking-optional'}
                onCheckedChange={(checked) => handleThinkingChange(Boolean(checked))}
                className="size-3.5 border-theme-border data-checked:bg-theme-primary data-checked:border-theme-primary text-theme-primary-fg shrink-0 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              />
              <span>{m.quiz_thinking_short()}</span>
            </label>
          </div>
        </div>
      </div>
    );
  }

  const submittedCount = currentSession.quizzes.filter((_, idx) => currentSession.submitted[idx]).length;

  return (
    <div className="warm-theme-primary my-8 rounded-2xl border border-theme-primary/30 bg-theme-primary/10 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-6 py-3 border-b border-theme-primary/30 bg-theme-primary/10 select-none">
        <div className="flex items-center gap-2">
          <Target size={18} className="text-theme-primary" />
          <span className="text-sm font-semibold text-theme-primary leading-none">{m.quiz_title()}</span>
        </div>

        <div className="flex items-center gap-2">
          <span className="px-2.5 py-0.5 rounded-full bg-theme-bg/60 border border-theme-border text-micro font-medium text-theme-muted">
            {allSubmitted
              ? m.quiz_quiz_passed()
              : `${submittedCount} / ${currentSession.quizzes.length}`}
          </span>
        </div>
      </div>

      <div className="p-6">
        <div className="space-y-8">
          {currentSession.quizzes.map((quiz, qIndex) => {
            const isSubmitted = currentSession.submitted[qIndex];
            const selectedIdx = currentSession.answers[qIndex];
            const isCorrect = selectedIdx === quiz.correctIndex;

            return (
              <div key={qIndex} className="space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-theme-muted">
                    {m.quiz_question_number({ index: qIndex + 1 })}
                  </span>
                  {quiz.difficulty && (
                    <span
                      className={`px-2.5 py-0.5 text-micro font-semibold rounded-full border ${
                        quiz.difficulty === 'hard'
                          ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/20'
                          : quiz.difficulty === 'medium'
                            ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20'
                            : 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/20'
                      }`}
                    >
                      {quiz.difficulty === 'hard'
                        ? m.diff_hard()
                        : quiz.difficulty === 'medium'
                          ? m.diff_medium()
                          : m.diff_easy()}
                    </span>
                  )}
                </div>

                <p className="font-medium text-theme-foreground">
                  {quiz.question}
                </p>

                <div className="space-y-2">
                  {quiz.options.map((opt: string, oIndex: number) => {
                    let btnClass = 'w-full text-left px-4 py-3 rounded-xl border text-sm transition-all cursor-pointer ';

                    if (isSubmitted) {
                      btnClass = 'w-full text-left px-4 py-3 rounded-xl border text-sm transition-all ';
                      if (oIndex === quiz.correctIndex) {
                        btnClass += 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300 ';
                      } else if (oIndex === selectedIdx) {
                        btnClass += 'bg-rose-500/10 border-rose-500/30 text-rose-700 dark:text-rose-300 ';
                      } else {
                        btnClass += 'bg-theme-bg border-theme-border text-theme-muted opacity-50 ';
                      }
                    } else {
                      if (selectedIdx === oIndex) {
                        btnClass += 'bg-theme-primary/10 border-theme-primary/30 text-theme-primary ring-2 ring-theme-primary/20';
                      } else {
                        btnClass += 'bg-theme-bg border-theme-border hover:border-theme-primary/30 text-theme-foreground hover:bg-theme-surface';
                      }
                    }

                    return (
                      <button
                        key={oIndex}
                        onClick={() => handleSelect(qIndex, oIndex)}
                        disabled={isSubmitted}
                        className={btnClass}
                      >
                        <div className="flex items-center justify-between">
                          <span>{opt}</span>
                          {isSubmitted && oIndex === quiz.correctIndex && (
                            <CheckCircle2 size={16} className="text-emerald-600 shrink-0 ml-2" />
                          )}
                          {isSubmitted && oIndex === selectedIdx && oIndex !== quiz.correctIndex && (
                            <XCircle size={16} className="text-rose-600 shrink-0 ml-2" />
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {!isSubmitted && selectedIdx !== undefined && (
                  <button
                    onClick={() => handleSubmit(qIndex)}
                    className="px-4 py-2 bg-theme-primary hover:opacity-90 text-theme-primary-fg text-sm font-medium rounded-lg transition-opacity cursor-pointer"
                  >
                    {m.quiz_submit()}
                  </button>
                )}

                {isSubmitted && (
                  <div
                    className={`p-4 rounded-xl text-sm ${
                      isCorrect
                        ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200 border border-emerald-500/20'
                        : 'bg-amber-500/10 text-amber-800 dark:text-amber-200 border border-amber-500/20'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <p className="font-semibold">
                        {isCorrect ? m.quiz_correct() : m.quiz_incorrect()}
                      </p>
                      {!isCorrect && (
                        <button
                          onClick={() => handleRetryQuestion(qIndex)}
                          className="text-xs text-amber-800 dark:text-amber-200 underline hover:opacity-80 cursor-pointer"
                        >
                          {m.quiz_retry()}
                        </button>
                      )}
                    </div>
                    {quiz.explanation && <p className="text-xs leading-relaxed opacity-90">{quiz.explanation}</p>}
                  </div>
                )}
              </div>
            );
          })}

          {allSubmitted && (
            <div className="mt-8 p-6 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 flex flex-col items-center justify-center gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="flex flex-col items-center text-center space-y-1">
                <CheckCircle2 size={32} className="text-emerald-600 shrink-0" />
                <h4 className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">
                  {m.quiz_completed_title()}
                </h4>
                <p className="text-xs text-theme-muted max-w-md mx-auto leading-relaxed">
                  {m.quiz_completed_desc()}
                </p>
              </div>

              <button
                onClick={resetCurrentSession}
                className="mt-2 px-5 py-1.5 bg-theme-primary hover:opacity-90 text-theme-primary-fg text-micro font-semibold rounded-full shadow-md transition-all active:scale-95 cursor-pointer"
              >
                {m.quiz_retry()}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
