'use client';
import * as m from '@/paraglide/messages';
import React from 'react';
import { BookOpen, Layers, ArrowRight } from 'lucide-react';
import { CommandGroup, CommandGroupLabel, CommandItem } from '@/components/ui/command';
import { cn } from '@/lib/utils';
import type { FeaturedTutorialItem } from '@/hooks/useDebouncedSearch';
import type { SuggestionActionItem } from '@/hooks/useSearchKeyboardNavigation';

interface SearchQuickActionsProps {
  featuredTutorials: FeaturedTutorialItem[];
  suggestions: SuggestionActionItem[];
  selectedIndex: number;
  recentCount: number;
  onSelect: (item: FeaturedTutorialItem | SuggestionActionItem) => void;
  onHover: (index: number) => void;
}

export function SearchQuickActions({
  featuredTutorials,
  suggestions,
  selectedIndex,
  recentCount,
  onSelect,
  onHover,
}: SearchQuickActionsProps) {
  return (
    <>
      {/* 1. 推荐教程 */}
      {featuredTutorials.length > 0 && (
        <CommandGroup className="mb-2">
          <CommandGroupLabel className="px-2 pt-1 pb-1 text-xs font-medium text-theme-muted/70 flex items-center gap-1.5">
            {m.search_recommended_tutorials()}
          </CommandGroupLabel>

          <div className="flex flex-col gap-0.5 my-0.5">
            {featuredTutorials.map((tut, idx) => {
              const globalIndex = recentCount + idx;
              const isSelected = globalIndex === selectedIndex;

              return (
                <CommandItem
                  key={tut.id}
                  onClick={() => onSelect(tut)}
                  onMouseEnter={() => onHover(globalIndex)}
                  className={cn(
                    'w-full text-left px-3 py-2 rounded-lg flex items-center justify-between gap-2.5 transition-all border my-0.5 group cursor-pointer',
                    isSelected
                      ? 'bg-sky-500/10 border-sky-500/30 text-theme-foreground shadow-2xs'
                      : 'border-transparent hover:bg-theme-surface/60'
                  )}
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <BookOpen className="w-3.5 h-3.5 text-theme-muted/80 shrink-0" />
                    <span className="text-xs sm:text-sm text-theme-foreground font-medium truncate">
                      {tut.title}
                    </span>
                  </div>
                  <div className="shrink-0 text-xs font-mono text-theme-muted/60 group-hover:text-theme-foreground transition-colors">
                    <span>{m.search_direct()}</span>
                  </div>
                </CommandItem>
              );
            })}
          </div>
        </CommandGroup>
      )}

      {/* 2. 快捷配置 */}
      {suggestions.length > 0 && (
        <CommandGroup className="mb-1">
          <CommandGroupLabel className="px-2 pt-1 pb-1 text-xs font-medium text-theme-muted/70 flex items-center gap-1.5">
            {m.search_quick_setup()}
          </CommandGroupLabel>

          <div className="flex flex-col gap-0.5 my-0.5">
            {suggestions.map((sug, idx) => {
              const globalIndex = recentCount + featuredTutorials.length + idx;
              const isSelected = globalIndex === selectedIndex;

              return (
                <CommandItem
                  key={sug.id}
                  onClick={() => onSelect(sug)}
                  onMouseEnter={() => onHover(globalIndex)}
                  className={cn(
                    'w-full text-left px-3 py-2 rounded-lg flex items-center justify-between gap-2.5 transition-all border my-0.5 group cursor-pointer',
                    isSelected
                      ? 'bg-sky-500/10 border-sky-500/30 text-theme-foreground shadow-2xs'
                      : 'border-transparent hover:bg-theme-surface/60'
                  )}
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <Layers className="w-3.5 h-3.5 text-purple-500 shrink-0" />
                    <div className="min-w-0 flex-1 flex items-center gap-2">
                      <span className="text-xs sm:text-sm text-theme-foreground font-medium truncate">
                        {sug.title}
                      </span>
                      {sug.description && (
                        <span className="text-xs text-theme-muted/70 truncate hidden sm:inline-block">
                          - {sug.description}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-xs font-mono text-theme-muted/60 group-hover:text-theme-foreground transition-colors">
                    <span className="flex items-center gap-1 text-xs">
                      {m.search_configure()}{' '}
                      <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
                    </span>
                  </div>
                </CommandItem>
              );
            })}
          </div>
        </CommandGroup>
      )}
    </>
  );
}
