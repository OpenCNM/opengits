'use client';
import * as m from '@/paraglide/messages';
import React from 'react';
import { BookOpen, Zap, FileText, Layers, ArrowRight, CornerDownLeft } from 'lucide-react';
import { CommandGroup, CommandGroupLabel, CommandItem, CommandEmpty } from '@/components/ui/command';
import { HighlightMatch } from '@/components/ui/HighlightMatch';
import { cn } from '@/lib/utils';
import type { SearchResultItem } from '@/app/api/search/route';
import type { InitialSearchItem } from '@/hooks/useSearchKeyboardNavigation';

interface SearchResultSectionProps {
  query: string;
  loading: boolean;
  results: SearchResultItem[];
  directItems: SearchResultItem[];
  docGroups: Array<{ repoKey: string; docs: SearchResultItem[] }>;
  bundleItems: SearchResultItem[];
  activeItemList: (SearchResultItem | InitialSearchItem)[];
  selectedIndex: number;
  onSelect: (item: SearchResultItem) => void;
  onHover: (index: number) => void;
}

export function SearchResultSection({
  query,
  loading,
  results,
  directItems,
  docGroups,
  bundleItems,
  activeItemList,
  selectedIndex,
  onSelect,
  onHover,
}: SearchResultSectionProps) {
  if (results.length === 0 && !loading) {
    return (
      <CommandEmpty className="py-8 px-4 text-center text-xs text-theme-muted">
        {m.search_empty_result({ query })}
      </CommandEmpty>
    );
  }

  return (
    <>
      {directItems.length > 0 && (
        <CommandGroup className="mb-2">
          <CommandGroupLabel className="px-2 pt-1 pb-1 text-xs font-semibold text-theme-muted uppercase tracking-wider flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-sky-500" /> {m.search_recommended_direct()}
          </CommandGroupLabel>
          <div className="flex flex-col gap-0.5 my-0.5">
            {directItems.map((res) => {
              const index = activeItemList.indexOf(res);
              const isSelected = index === selectedIndex;
              const isExists = res.type === 'repository_exists';
              const isImportCta = res.type === 'repository_import_cta';

              return (
                <CommandItem
                  key={res.id}
                  onClick={() => onSelect(res)}
                  onMouseEnter={() => onHover(index)}
                  className={cn(
                    'w-full text-left px-3 py-2 rounded-lg flex items-center justify-between gap-2.5 transition-all border my-0.5 group cursor-pointer',
                    isSelected
                      ? 'bg-sky-500/10 border-sky-500/30 text-theme-foreground shadow-2xs'
                      : 'border-transparent hover:bg-theme-surface/60'
                  )}
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <div className="shrink-0 text-theme-muted">
                      {isExists && <BookOpen className="w-4 h-4 text-emerald-500" />}
                      {isImportCta && <Zap className="w-4 h-4 text-sky-500 animate-pulse" />}
                    </div>

                    <div className="min-w-0 flex-1 flex items-center gap-2">
                      <HighlightMatch
                        text={res.title}
                        query={query}
                        className="font-semibold text-xs sm:text-sm text-theme-foreground truncate"
                      />

                      {isExists && (
                        <span className="px-2 py-0.5 text-xs rounded font-mono bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 shrink-0">
                          {m.search_generated_tutorial()}
                        </span>
                      )}
                      {isImportCta && (
                        <span className="px-2 py-0.5 text-xs rounded font-mono bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20 shrink-0">
                          {m.search_one_click_import()}
                        </span>
                      )}

                      {res.description && (
                        <p className="text-xs text-theme-muted/75 truncate hidden md:inline-block min-w-0 flex-1">
                          - <HighlightMatch text={res.description} query={query} />
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="shrink-0 flex items-center text-xs font-mono">
                    {isImportCta ? (
                      <span className="flex items-center gap-1 text-sky-500 font-medium text-xs">
                        {m.search_one_click_import()} <CornerDownLeft className="w-3 h-3" />
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-emerald-500 font-medium text-xs">
                        {m.search_direct_tutorial()} <ArrowRight className="w-3 h-3" />
                      </span>
                    )}
                  </div>
                </CommandItem>
              );
            })}
          </div>
        </CommandGroup>
      )}

      {docGroups.map((group) => (
        <CommandGroup key={group.repoKey} className="mb-2.5">
          <CommandGroupLabel className="px-2.5 py-1 text-xs font-mono text-theme-foreground flex items-center justify-between bg-theme-surface/50 rounded-md border border-theme-border/50 mb-1 select-none">
            <div className="flex items-center gap-1.5 min-w-0">
              <BookOpen className="w-3.5 h-3.5 text-theme-primary shrink-0" />
              <HighlightMatch text={group.repoKey} query={query} className="font-semibold truncate" />
            </div>
            <span className="px-2 py-0.5 text-xs rounded font-mono bg-theme-bg border border-theme-border/60 text-theme-muted shrink-0">
              {m.github_origin_docs_count({ count: group.docs.length })}
            </span>
          </CommandGroupLabel>

          <div className="flex flex-col gap-0.5 my-0.5 pl-1.5 border-l-2 border-theme-border/40 ml-2">
            {group.docs.map((doc) => {
              const index = activeItemList.indexOf(doc);
              const isSelected = index === selectedIndex;

              return (
                <CommandItem
                  key={doc.id}
                  onClick={() => onSelect(doc)}
                  onMouseEnter={() => onHover(index)}
                  className={cn(
                    'w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2.5 transition-all border my-0.5 group cursor-pointer',
                    isSelected
                      ? 'bg-sky-500/10 border-sky-500/30 text-theme-foreground shadow-2xs'
                      : 'border-transparent hover:bg-theme-surface/60'
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <FileText className="w-3.5 h-3.5 text-theme-muted/70 shrink-0" />

                    <div className="min-w-0 flex-1 flex items-center gap-2">
                      <HighlightMatch
                        text={doc.title}
                        query={query}
                        className="font-medium text-xs sm:text-sm text-theme-foreground truncate"
                      />

                      {doc.description && (
                        <p className="text-xs text-theme-muted/75 truncate hidden sm:inline-block min-w-0 flex-1">
                          - <HighlightMatch text={doc.description} query={query} />
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="shrink-0 flex items-center text-xs font-mono text-theme-muted group-hover:text-sky-500 transition-colors">
                    <span className="flex items-center gap-1 text-xs">
                      {m.common_read()}{' '}
                      <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
                    </span>
                  </div>
                </CommandItem>
              );
            })}
          </div>
        </CommandGroup>
      ))}

      {bundleItems.length > 0 && (
        <CommandGroup className="mb-2">
          <CommandGroupLabel className="px-2 pt-1 pb-1 text-xs font-semibold text-theme-muted uppercase tracking-wider flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-purple-500" /> {m.search_mcp_bundles()}
          </CommandGroupLabel>
          <div className="flex flex-col gap-0.5 my-0.5">
            {bundleItems.map((b) => {
              const index = activeItemList.indexOf(b);
              const isSelected = index === selectedIndex;

              return (
                <CommandItem
                  key={b.id}
                  onClick={() => onSelect(b)}
                  onMouseEnter={() => onHover(index)}
                  className={cn(
                    'w-full text-left px-3 py-2 rounded-lg flex items-center justify-between gap-2.5 transition-all border my-0.5 group cursor-pointer',
                    isSelected
                      ? 'bg-purple-500/10 border-purple-500/30 text-theme-foreground shadow-2xs'
                      : 'border-transparent hover:bg-theme-surface/60'
                  )}
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <Layers className="w-4 h-4 text-purple-500 shrink-0" />
                    <div className="min-w-0 flex-1 flex items-center gap-2">
                      <HighlightMatch
                        text={b.title}
                        query={query}
                        className="font-semibold text-xs sm:text-sm text-theme-foreground truncate"
                      />
                      {b.description && (
                        <p className="text-xs text-theme-muted/75 truncate hidden md:inline-block min-w-0 flex-1">
                          - <HighlightMatch text={b.description} query={query} />
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-xs font-mono text-purple-600 dark:text-purple-400 group-hover:text-purple-500 transition-colors">
                    <span className="flex items-center gap-1 text-xs">
                      {m.common_view()}{' '}
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
