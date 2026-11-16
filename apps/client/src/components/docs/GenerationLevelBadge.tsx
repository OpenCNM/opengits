import React from 'react';
import * as m from '@/paraglide/messages';
import { GENERATION_LEVEL } from '@/lib/constants';

interface GenerationLevelBadgeProps {
  level?: string | null;
  className?: string;
}

/**
 * 内容等级徽章（读者知情分级，CDC）：转录生成时落列的确定性事实——
 * 读者一眼可知本章是 AI 增强成品、纯翻译、原文收录还是代码精讲。
 * 未标注的存量数据（null）与未知等级静默不渲染，零噪声。
 */
export function GenerationLevelBadge({ level, className = '' }: GenerationLevelBadgeProps) {
  if (!level) return null;

  let label: string | null = null;
  switch (level) {
    case GENERATION_LEVEL.ENHANCED:
      label = m.generation_level_enhanced();
      break;
    case GENERATION_LEVEL.TRANSLATED:
      label = m.generation_level_translated();
      break;
    case GENERATION_LEVEL.ORIGINAL:
      label = m.generation_level_original();
      break;
    case GENERATION_LEVEL.CODE_LESSON:
      label = m.generation_level_code_lesson();
      break;
    default:
      return null;
  }

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-micro font-medium border border-theme-border/60 bg-theme-muted/10 text-theme-muted shrink-0 select-none ${className}`}
      data-testid="generation-level-badge"
    >
      {label}
    </span>
  );
}
