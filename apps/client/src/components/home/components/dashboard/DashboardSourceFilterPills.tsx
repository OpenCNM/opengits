'use client';

import React from 'react';
import { Globe } from 'lucide-react';
import { GithubIcon } from '@/components/repo/RepoGithubOriginPopover';
import * as m from '@/paraglide/messages';
import type { DashboardSourceType } from '@/lib/search/smart-repo-search';

interface DashboardSourceFilterPillsProps {
  sourceType: DashboardSourceType;
  onSelectSourceType: (type: DashboardSourceType) => void;
  counts: {
    all: number;
    github: number;
    webdoc: number;
  };
  /** 紧凑侧栏模式：使用短文案并均分宽度，适配窄侧栏单行展示 */
  compact?: boolean;
}

export function DashboardSourceFilterPills({
  sourceType,
  onSelectSourceType,
  counts,
  compact = false,
}: DashboardSourceFilterPillsProps) {
  const options: Array<{
    id: DashboardSourceType;
    label: string;
    count: number;
    Icon?: React.ComponentType<{ className?: string }>;
  }> = [
    { id: 'all', label: m.dashboard_source_all(), count: counts.all },
    {
      id: 'github',
      label: compact ? m.dashboard_source_github_short() : m.dashboard_source_github(),
      count: counts.github,
      Icon: GithubIcon,
    },
    {
      id: 'webdoc',
      label: compact ? m.dashboard_source_webdoc_short() : m.dashboard_source_webdoc(),
      count: counts.webdoc,
      Icon: Globe,
    },
  ];

  return (
    <div
      className={
        compact
          ? 'grid grid-cols-3 gap-0.5 w-full bg-theme-surface/60 dark:bg-theme-surface/40 p-0.5 rounded-lg text-xs font-sans shrink-0 border border-theme-border/60'
          : 'flex items-center gap-1 bg-theme-surface/60 dark:bg-theme-surface/40 p-0.5 rounded-lg text-xs font-sans shrink-0 border border-theme-border/50'
      }
    >
      {options.map((opt) => {
        const isSelected = sourceType === opt.id;
        const Icon = opt.Icon;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onSelectSourceType(opt.id)}
            aria-pressed={isSelected}
            className={`inline-flex items-center justify-center rounded-md transition-all cursor-pointer select-none min-w-0 ${
              compact ? 'gap-1 px-1.5 py-1 text-caption' : 'gap-1.5 px-2.5 py-1 text-xs'
            } ${
              isSelected
                ? 'bg-theme-bg text-theme-foreground font-medium shadow-xs border border-theme-border/60'
                : 'text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/50 border border-transparent'
            }`}
          >
            {Icon && <Icon className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} shrink-0 opacity-80`} />}
            <span className="truncate">{opt.label}</span>
            <span className={`text-micro font-mono px-1 rounded shrink-0 ${
              isSelected ? 'bg-theme-surface text-theme-foreground/90' : 'text-theme-muted/70'
            }`}>
              {opt.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
