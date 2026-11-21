'use client';

import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api/client';
import { useImportWizardStore } from '@/lib/stores/import-wizard-store';
import type { ReorganizeCategoryIntent } from '@/lib/constants';
import * as m from '@/paraglide/messages';
import type { WorkbenchOutlineCategory } from './editor/OutlineCategoryBlock';

/**
 * 「保存并使用」短标签长度上限：客户端确定性镜像 /api/ai/expand-outline-prompt
 * 服务端对 shortLabel 的截断钳制，保证本地派生与服务端收敛结果一致。
 */
const SAVE_LABEL_MAX_LENGTH = 48;

export interface ReorganizeCustomComposerProps {
  /** 当前发起分类；缺省视为全局自定义入口（'general'） */
  categoryIntent?: ReorganizeCategoryIntent;
  /** 初始输入（如恢复中的草稿） */
  initialInput?: string;
  /** 是否自动聚焦 textarea */
  autoFocus?: boolean;
  /** 提交完整指令（父组件负责写入 store 并触发重排/关闭气泡） */
  onSubmit: (prompt: string) => void;
  /** 保存为该分类的自定义子项并使用；不传则隐藏「保存并使用」按钮 */
  onSaveAndUse?: (label: string, prompt: string) => void;
}

/**
 * 自定义要求编排器（自 WorkbenchReorganizeBar 气泡内抽取的共享组件）：
 * 承载「输入 → AI 扩写 → 预览（短标签 chip + 采用/放弃）→ 还原 → 提交/保存并使用」完整闭环。
 * 抽取意图：编排栏气泡与「换个思路」面板各分类气泡需复用同一套扩写交互，故将
 * 状态机与请求载荷构建内聚于此；组件自身零 store 写入——所有落库/重排/关闭气泡行为
 * 均通过 onSubmit / onSaveAndUse 回调交还父组件收口，遵循「确定性代码守门 + LLM 仅产草稿」
 * 边界：扩写结果先经存在性校验才进入 textarea，旧版响应缺失 shortLabel 时安全回退为空串。
 */
export function ReorganizeCustomComposer({
  categoryIntent,
  initialInput,
  autoFocus = true,
  onSubmit,
  onSaveAndUse,
}: ReorganizeCustomComposerProps): React.JSX.Element {
  // 只读投影：扩写请求载荷所需的仓库上下文（与 Bar 保持同源，不做任何写回）
  const customOutline = useImportWizardStore((s) => s.customOutline);
  const scoutData = useImportWizardStore((s) => s.scoutData);
  const category = useImportWizardStore((s) => s.category);
  const selectedTags = useImportWizardStore((s) => s.selectedTags);
  const selectedPrefix = useImportWizardStore((s) => s.selectedPrefix);
  const targetLanguage = useImportWizardStore((s) => s.targetLanguage);

  const [customInput, setCustomInput] = useState(() => initialInput ?? '');
  const [expandedDraft, setExpandedDraft] = useState<string | null>(null);
  /** 最近一次扩写返回的短标签（与 expandedPrompt 成对存储；缺失时安全回退为空串） */
  const [expandedLabel, setExpandedLabel] = useState('');
  /** 最近一次扩写的完整 prompt（采用后仍保留，供「保存并使用」做等值判定） */
  const [lastExpandedPrompt, setLastExpandedPrompt] = useState('');
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
        setExpandError(m.workbench_reorganize_expand_failed());
        return;
      }

      const expanded = data.expandedPrompt.trim();
      setExpandedDraft(expanded);
      // 短标签与扩写 prompt 成对存储；旧版响应缺失该字段时不崩溃（空串即隐藏 chip）
      setExpandedLabel(data.shortLabel?.trim() || '');
      setLastExpandedPrompt(expanded);
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

  /** 提交/保存成功后的扩写瞬态清理（镜像 Bar 的 handleSubmitCustom 收尾） */
  const resetExpansionUi = () => {
    setExpandedDraft(null);
    setDraftBeforeAdopt(null);
    setExpandError(null);
    setExpandedLabel('');
    setLastExpandedPrompt('');
  };

  const handleSubmit = () => {
    if (isExpanding) return;
    // 存在未处理的扩写预览时，「开始」默认采用扩写结果提交（拒绝走显式「放弃」），
    // 避免用户点开始却把未扩写的原始草稿发出去；无预览时按输入原文提交。
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

  /**
   * 「保存并使用」标签派生（客户端确定性镜像服务端钳制，不依赖 LLM）：
   * 当前输入与最近一次扩写结果等值且短标签非空 → 直接采用该短标签；
   * 否则按截断上限钳制原始输入。
   */
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
        <textarea
          ref={textareaRef}
          autoFocus={autoFocus}
          rows={3}
          disabled={isExpanding}
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={m.workbench_reorganize_input_placeholder()}
          className="w-full resize-none text-xs font-sans leading-relaxed bg-theme-surface/60 border border-theme-border/70 rounded-lg px-2.5 py-2 text-theme-foreground placeholder:text-theme-muted/60 focus:outline-none focus:border-theme-primary transition-colors disabled:opacity-50"
        />
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
              {/* 短标签仅在带「保存并使用」的分类入口展示（全局自定义为一次性指令，不落库无标签语义） */}
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

      {expandError && (
        <p className="text-micro font-sans text-rose-500">{expandError}</p>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={isExpanding || customOutline.length === 0}
            onClick={handleAiExpand}
            className="px-2.5 py-1.5 text-xs font-sans rounded-lg border border-theme-border/70 bg-theme-surface/50 text-theme-muted hover:text-theme-foreground hover:border-theme-border hover:bg-theme-surface transition-all cursor-pointer active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {m.workbench_reorganize_ai_expand()}
          </button>
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
            {m.workbench_reorganize_submit()}
          </button>
        </div>
      </div>
    </div>
  );
}
