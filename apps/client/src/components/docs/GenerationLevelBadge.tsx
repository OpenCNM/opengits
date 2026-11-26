import React from 'react';
import * as m from '@/paraglide/messages';
import { GENERATION_LEVEL } from '@/lib/constants';

interface GenerationLevelBadgeProps {
  level?: string | null;
  className?: string;
}

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
