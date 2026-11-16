'use client';
import * as m from '@/paraglide/messages';
import React from 'react';
import { Clock, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RecentSearchItem } from '@/hooks/useSearchKeyboardNavigation';

interface SearchRecentGroupProps {
  recentSearches: string[];
  selectedIndex: number;
  onSelect: (item: RecentSearchItem) => void;
  onHover: (index: number) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
}

export function SearchRecentGroup({
  recentSearches,
  selectedIndex,
  onSelect,
  onHover,
  onRemove,
  onClear,
}: SearchRecentGroupProps) {
  if (recentSearches.length === 0) return null;

  return (
    <div className="px-2 pt-1 pb-2 mb-2 border-b border-theme-border/20">
      <div className="flex items-center justify-between pb-1.5 px-0.5">
        <span className="text-xs font-medium text-theme-muted flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5 text-theme-muted/70" />
          {m.search_recent_searches()}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          className="text-xs text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer"
        >
          {m.search_clear()}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {recentSearches.map((kw, idx) => {
          const item: RecentSearchItem = { id: `recent-${idx}`, type: 'recent', query: kw };
          const isSelected = idx === selectedIndex;

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item)}
              onMouseEnter={() => onHover(idx)}
              className={cn(
                'group inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-full text-xs font-sans transition-colors cursor-pointer select-none border',
                isSelected
                  ? 'bg-theme-surface/80 border-theme-border text-theme-foreground'
                  : 'bg-theme-surface/30 text-theme-muted/70 hover:text-theme-muted/90 border-theme-border/30 hover:border-theme-border/50 hover:bg-theme-surface/50'
              )}
            >
              <span className="truncate max-w-[160px]">{kw}</span>
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(idx);
                }}
                className="p-0.5 rounded-full text-theme-muted/40 hover:text-theme-muted/80 hover:bg-theme-foreground/5 transition-colors"
                title={m.common_delete()}
              >
                <X className="w-3 h-3" />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
