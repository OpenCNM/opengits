'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { useImportWizardStore, wizardSetters } from '@/lib/stores/import-wizard-store';
import * as m from '@/paraglide/messages';
import type { WorkbenchOutlineCategory } from './editor/OutlineCategoryBlock';
import {
  getReorganizeMotives,
  type ReorganizeMotive,
  type ReorganizeOptions,
} from './WorkbenchReorganizePanel';

interface WorkbenchReorganizeBarProps {
  onReorganize?: (options: ReorganizeOptions) => void;
  disabled?: boolean;
}

/**
 * 底部决策栏内嵌的 AI 重新编排快捷组（方案 A）：
 * 1 个主导触发按钮（换个思路）+ 4 个次级按钮（3 个一键微调方向 + 1 个自定义要求气泡框），
 * 自定义要求支持基于当前大纲与项目上下文的「AI 扩写 → 采用 → 还原」闭环。
 */
export function WorkbenchReorganizeBar({
  onReorganize,
  disabled = false,
}: WorkbenchReorganizeBarProps) {
  const storePrompt = useImportWizardStore((s) => s.customPrompt);
  const customOutline = useImportWizardStore((s) => s.customOutline);
  const scoutData = useImportWizardStore((s) => s.scoutData);
  const category = useImportWizardStore((s) => s.category);
  const selectedTags = useImportWizardStore((s) => s.selectedTags);
  const selectedPrefix = useImportWizardStore((s) => s.selectedPrefix);
  const targetLanguage = useImportWizardStore((s) => s.targetLanguage);

  const motives = useMemo(() => getReorganizeMotives(), []);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [customInput, setCustomInput] = useState(() =>
    storePrompt && !motives.some((item) => item.basePrompt === storePrompt) ? storePrompt : '',
  );
  const [expandedDraft, setExpandedDraft] = useState<string | null>(null);
  const [draftBeforeAdopt, setDraftBeforeAdopt] = useState<string | null>(null);
  const [isExpanding, setIsExpanding] = useState(false);
  const [expandError, setExpandError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const expandAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      expandAbortRef.current?.abort();
    };
  }, []);

  const primaryMotive = motives[0];
  const secondaryMotives = motives.slice(1);

  const triggerMotive = (motiveId: ReorganizeMotive) => {
    if (disabled) return;
    const motive = motives.find((item) => item.id === motiveId) ?? primaryMotive;
    wizardSetters.setCustomPrompt(motive.basePrompt);
    onReorganize?.({
      customPrompt: motive.basePrompt,
      pacing: motive.pacing,
      learnerArchetype: motive.learnerArchetype,
    });
  };

  const handlePopoverOpenChange = (open: boolean) => {
    setPopoverOpen(open);
    if (!open) {
      expandAbortRef.current?.abort();
      setIsExpanding(false);
    }
  };

  const handleAiExpand = async () => {
    if (disabled || isExpanding || customOutline.length === 0) return;

    expandAbortRef.current?.abort();
    const controller = new AbortController();
    expandAbortRef.current = controller;

    setIsExpanding(true);
    setExpandError(null);

    try {
      const outlinePayload = (customOutline as WorkbenchOutlineCategory[]).map((cat) => ({
        partTitle: cat.partTitle || undefined,
        title: cat.title || cat.name || '',
        files: Array.isArray(cat.files)
          ? cat.files
              .map((file) => file.path || file.shortTitle || '')
              .filter(Boolean)
              .slice(0, 8)
          : [],
      }));

      const repoSlug =
        scoutData?.owner && scoutData?.repo ? `${scoutData.owner}/${scoutData.repo}` : '';

      const res = await fetch('/api/ai/expand-outline-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          userInput: customInput,
          repoSlug,
          domain: category || '',
          tags: selectedTags,
          scopePrefix: selectedPrefix || '',
          targetLanguage,
          outline: outlinePayload,
        }),
      });

      if (!res.ok) {
        let message = m.workbench_reorganize_expand_failed();
        try {
          const errBody = await res.json();
          if (typeof errBody?.error === 'string' && errBody.error.trim()) {
            message = errBody.error;
          }
        } catch (parseErr) {
          // 容错降级: 服务端返回非 JSON 错误体时保留通用错误提示并记录日志
          console.warn('[WorkbenchReorganizeBar] Failed to parse error response:', parseErr);
        }
        setExpandError(message);
        return;
      }

      const data = await res.json();
      if (!data?.expandedPrompt) {
        setExpandError(m.workbench_reorganize_expand_failed());
        return;
      }

      setExpandedDraft(String(data.expandedPrompt).trim());
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setExpandError(
        err instanceof Error && err.message
          ? err.message
          : m.workbench_reorganize_expand_failed(),
      );
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

  const handleSubmitCustom = () => {
    if (disabled || isExpanding) return;
    const trimmed = customInput.trim();
    if (!trimmed) return;
    wizardSetters.setCustomPrompt(trimmed);
    setExpandedDraft(null);
    setDraftBeforeAdopt(null);
    setExpandError(null);
    setPopoverOpen(false);
    onReorganize?.({
      customPrompt: trimmed,
      pacing: 'normal',
      learnerArchetype: 'architecture_overview',
    });
  };

  const hasCustomPrompt = customInput.trim().length > 0;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* 1 个主导触发按钮：一键换个思路 */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => triggerMotive(primaryMotive.id)}
        title={primaryMotive.sub}
        className="px-3 py-1.5 text-xs font-serif font-medium rounded-lg border border-theme-primary/40 bg-theme-primary/10 text-theme-primary hover:bg-theme-primary/20 transition-all cursor-pointer active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
      >
        {primaryMotive.label}
      </button>

      {/* 3 个次级一键方向按钮 */}
      {secondaryMotives.map((motive) => (
        <button
          key={motive.id}
          type="button"
          disabled={disabled}
          onClick={() => triggerMotive(motive.id)}
          title={motive.sub}
          className="px-2.5 py-1.5 text-xs font-sans rounded-lg border border-theme-border/60 bg-theme-surface/50 text-theme-muted hover:text-theme-foreground hover:border-theme-border hover:bg-theme-surface transition-all cursor-pointer active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          {motive.label}
        </button>
      ))}

      {/* 第 4 个次级按钮：自定义要求向上气泡框 */}
      <Popover open={popoverOpen} onOpenChange={handlePopoverOpenChange}>
        <PopoverTrigger
          disabled={disabled}
          className={`px-2.5 py-1.5 text-xs font-sans rounded-lg border transition-all cursor-pointer active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shrink-0 flex items-center gap-1.5 ${
            popoverOpen || hasCustomPrompt
              ? 'border-theme-primary/40 bg-theme-primary/10 text-theme-foreground'
              : 'border-theme-border/60 bg-theme-surface/50 text-theme-muted hover:text-theme-foreground hover:border-theme-border hover:bg-theme-surface'
          }`}
        >
          <span>{m.workbench_reorganize_custom_btn()}</span>
          {hasCustomPrompt && (
            <span className="w-1.5 h-1.5 rounded-full bg-theme-primary shrink-0" />
          )}
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="end"
          sideOffset={8}
          className="w-88 sm:w-[28rem] p-3 bg-theme-bg border border-theme-border rounded-xl shadow-lg"
        >
          <div className="flex flex-col gap-2.5">
            <textarea
              ref={textareaRef}
              autoFocus
              rows={3}
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSubmitCustom();
                }
              }}
              placeholder={m.workbench_reorganize_input_placeholder()}
              className="w-full resize-none text-xs font-sans leading-relaxed bg-theme-surface/60 border border-theme-border/70 rounded-lg px-2.5 py-2 text-theme-foreground placeholder:text-theme-muted/60 focus:outline-none focus:border-theme-primary transition-colors"
            />

            {expandedDraft !== null && (
              <div className="rounded-lg border border-theme-primary/30 bg-theme-surface/70 p-2.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-micro font-medium text-theme-primary">
                    {m.workbench_reorganize_expand_preview_label()}
                  </span>
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

            {expandError && (
              <p className="text-micro font-sans text-rose-500">{expandError}</p>
            )}

            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={disabled || isExpanding || customOutline.length === 0}
                  onClick={handleAiExpand}
                  className="px-2.5 py-1.5 text-xs font-sans rounded-lg border border-theme-border/70 bg-theme-surface/50 text-theme-muted hover:text-theme-foreground hover:border-theme-border hover:bg-theme-surface transition-all cursor-pointer active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isExpanding
                    ? m.workbench_reorganize_ai_expanding()
                    : m.workbench_reorganize_ai_expand()}
                </button>
                {draftBeforeAdopt !== null && (
                  <button
                    type="button"
                    disabled={disabled || isExpanding}
                    onClick={handleRestoreDraft}
                    className="px-2 py-1.5 text-xs font-sans rounded-lg text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/60 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {m.workbench_reorganize_expand_restore()}
                  </button>
                )}
              </div>

              <button
                type="button"
                disabled={disabled || isExpanding || !customInput.trim()}
                onClick={handleSubmitCustom}
                className="px-3.5 py-1.5 bg-theme-primary text-theme-primary-fg font-serif font-medium text-xs rounded-lg hover:opacity-90 active:scale-95 transition-all shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {m.workbench_reorganize_submit()}
              </button>
            </div>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
