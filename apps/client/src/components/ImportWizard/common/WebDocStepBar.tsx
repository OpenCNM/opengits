'use client';

import React from 'react';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import * as m from '@/paraglide/messages';
import { cn } from '@/lib/utils';
import {
  getWebDocStageIndex,
  type WebDocJourneyStage,
} from '@/lib/import-wizard/webdoc-scope';

export interface WebDocStepBarProps {
  activeStage: WebDocJourneyStage;
  /** 嗅探失败时在步骤 2 展示警示态，不再误标已完成 */
  scoutFailed?: boolean;
  onBackToInput?: () => void;
  className?: string;
}

interface StepDefinition {
  key: WebDocJourneyStage;
  stepNumber: number;
  label: () => string;
  asyncActive?: boolean;
}

const STEP_DEFINITIONS: readonly StepDefinition[] = [
  { key: 'input', stepNumber: 1, label: () => m.webdoc_wizard_step_input() },
  { key: 'scout', stepNumber: 2, label: () => m.webdoc_wizard_step_scout(), asyncActive: true },
  { key: 'confirm', stepNumber: 3, label: () => m.webdoc_wizard_step_confirm() },
  { key: 'crawl', stepNumber: 4, label: () => m.webdoc_wizard_step_crawl(), asyncActive: true },
  { key: 'done', stepNumber: 5, label: () => m.webdoc_wizard_step_done() },
];

/**
 * 网页文档导入横向引导步骤条：
 * 输入链接 → 嗅探站点 → 确认目录 → 开始抓取 → 完成导入
 */
export function WebDocStepBar({ activeStage, scoutFailed = false, onBackToInput, className }: WebDocStepBarProps) {
  const activeIndex = getWebDocStageIndex(activeStage);

  return (
    <nav aria-label={m.webdoc_import_title()} className={cn('w-full', className)}>
      <ol className="flex items-center justify-center gap-1.5 sm:gap-2 overflow-x-auto no-scrollbar py-0.5 select-none">
        {STEP_DEFINITIONS.map((item, idx) => {
          // 已经过去的步骤保持灰色，仅高亮当前进行中或最终完成步骤
          const isPast = idx < activeIndex;
          const isCurrent = idx === activeIndex;
          const isDoneCurrent = isCurrent && activeStage === 'done';
          const isStepError = isCurrent && item.key === 'scout' && scoutFailed;
          const canReturnToInput =
            item.key === 'input' &&
            Boolean(onBackToInput) &&
            (activeStage === 'scout' || activeStage === 'confirm');

          const pillContent = (
            <>
              <span
                className={cn(
                  'w-4 h-4 rounded-full flex items-center justify-center text-micro font-mono shrink-0 transition-colors',
                  isPast
                    ? 'bg-theme-border/60 text-theme-muted'
                    : isDoneCurrent
                      ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                      : isStepError
                        ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400'
                        : isCurrent
                          ? 'bg-theme-primary text-theme-primary-fg font-bold'
                          : 'bg-theme-surface border border-theme-border/70 text-theme-muted/70',
                )}
              >
                {isPast || isDoneCurrent ? (
                  <Check size={10} strokeWidth={2.5} />
                ) : isStepError ? (
                  <AlertCircle size={10} strokeWidth={2.5} />
                ) : isCurrent && item.asyncActive ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  item.stepNumber
                )}
              </span>
              <span className="whitespace-nowrap">{item.label()}</span>
            </>
          );

          const pillClass = cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-caption font-sans transition-all shrink-0',
            isPast
              ? 'bg-theme-surface/40 border-theme-border/45 text-theme-muted'
              : isDoneCurrent
                ? 'bg-emerald-500/10 border-emerald-500/35 text-emerald-600 dark:text-emerald-400 font-semibold shadow-2xs'
                : isStepError
                  ? 'bg-amber-500/10 border-amber-500/35 text-amber-600 dark:text-amber-400 font-semibold shadow-2xs'
                  : isCurrent
                    ? 'bg-theme-primary/10 border-theme-primary/40 text-theme-primary font-semibold shadow-2xs'
                    : 'bg-theme-bg/50 border-theme-border/40 text-theme-muted/65',
            canReturnToInput && 'hover:border-theme-primary/40 hover:text-theme-primary cursor-pointer',
          );

          return (
            <React.Fragment key={item.key}>
              <li
                aria-current={isCurrent ? 'step' : undefined}
                className="shrink-0"
              >
                {canReturnToInput ? (
                  <button type="button" onClick={onBackToInput} className={pillClass}>
                    {pillContent}
                  </button>
                ) : (
                  <div className={pillClass}>{pillContent}</div>
                )}
              </li>

              {idx < STEP_DEFINITIONS.length - 1 && (
                <li aria-hidden="true" className="flex-1 min-w-2 max-w-8 flex items-center">
                  <span
                    className={cn(
                      'w-full h-px transition-colors',
                      idx < activeIndex ? 'bg-theme-border/80' : 'bg-theme-border/45',
                    )}
                  />
                </li>
              )}
            </React.Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
