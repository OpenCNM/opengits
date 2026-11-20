'use client';

import { useMemo, useState } from 'react';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { useImportWizardStore, wizardSetters } from '@/lib/stores/import-wizard-store';
import * as m from '@/paraglide/messages';
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
 * 去除多余图标，实现单次点击直达重排。
 */
export function WorkbenchReorganizeBar({
  onReorganize,
  disabled = false,
}: WorkbenchReorganizeBarProps) {
  const storePrompt = useImportWizardStore((s) => s.customPrompt);
  const motives = useMemo(() => getReorganizeMotives(), []);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [customInput, setCustomInput] = useState(() =>
    storePrompt && !motives.some((item) => item.basePrompt === storePrompt) ? storePrompt : '',
  );

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

  const handleSubmitCustom = () => {
    if (disabled) return;
    const trimmed = customInput.trim();
    if (!trimmed) return;
    wizardSetters.setCustomPrompt(trimmed);
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
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
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
          className="w-80 sm:w-96 p-3 bg-theme-bg border border-theme-border rounded-xl shadow-lg"
        >
          <div className="flex flex-col gap-2">
            <textarea
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
            <div className="flex justify-end">
              <button
                type="button"
                disabled={disabled || !customInput.trim()}
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
