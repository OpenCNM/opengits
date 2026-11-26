'use client';
import * as m from '@/paraglide/messages';

import React, { useState, useEffect, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { X } from 'lucide-react';
import type { SharedProps } from 'fumadocs-ui/contexts/search';
import {
  CommandDialog,
  CommandDialogPopup,
  Command,
  CommandPanel,
  CommandInput,
  CommandList,
  CommandFooter,
} from '@/components/ui/command';
import { Spinner } from '@/components/ui/spinner';
import { Kbd } from '@/components/ui/kbd';
import type { SearchResultItem } from '@/app/api/search/route';
import { useRecentSearches } from '@/hooks/use-recent-searches';
import { useDebouncedSearch } from '@/hooks/useDebouncedSearch';
import {
  useSearchKeyboardNavigation,
  type SuggestionActionItem,
  type InitialSearchItem,
} from '@/hooks/useSearchKeyboardNavigation';
import { SearchRecentGroup } from './search/SearchRecentGroup';
import { SearchQuickActions } from './search/SearchQuickActions';
import { SearchResultSection } from './search/SearchResultSection';

export default function CustomSearchDialog({ open, onOpenChange }: SharedProps) {
  const params = useParams<{ owner?: string; repo?: string }>();
  const owner = params?.owner;
  const repo = params?.repo;
  const [query, setQuery] = useState('');

  const { recentSearches, reload: reloadRecentSearches, addSearch, removeSearch, clearSearches } =
    useRecentSearches();

  useEffect(() => {
    if (open) {
      reloadRecentSearches();
    } else {
      setQuery('');
    }
  }, [open, reloadRecentSearches]);

  const {
    results,
    loading,
    featuredTutorials,
    directItems,
    bundleItems,
    docGroups,
  } = useDebouncedSearch({
    open,
    query,
    owner,
    repo,
  });

  const suggestions: SuggestionActionItem[] = useMemo(
    () => [
      {
        id: 'sug-mcp',
        type: 'suggestion',
        title: m.search_mcp_config_title(),
        description: m.search_mcp_config_desc(),
        url: '/settings/mcp-tokens',
      },
    ],
    []
  );

  const initialItems: InitialSearchItem[] = [
    ...recentSearches.map((kw, i) => ({ id: `recent-${i}`, type: 'recent' as const, query: kw })),
    ...featuredTutorials,
    ...suggestions,
  ];

  const activeItemList: (SearchResultItem | InitialSearchItem)[] =
    query.trim() === ''
      ? initialItems
      : [
          ...directItems,
          ...docGroups.flatMap((g) => g.docs),
          ...bundleItems,
        ];

  const { selectedIndex, setSelectedIndex, handleSelectResult, handleKeyDown } =
    useSearchKeyboardNavigation({
      query,
      setQuery,
      activeItemList,
      onOpenChange,
      addSearch,
    });

  const placeholderText =
    owner && repo ? m.search_in_repo({ owner, repo }) : m.search_tutorials_placeholder();

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup className="max-w-2xl max-h-[85vh] border border-theme-border bg-theme-bg text-theme-foreground shadow-2xl overflow-hidden p-0 rounded-2xl font-sans flex flex-col">
        <Command>
          <CommandPanel className="bg-transparent border-0 shadow-none flex flex-col flex-1 min-h-0">
            <div className="relative flex items-center justify-between w-full h-14 min-h-[56px] shrink-0 border-b border-theme-border/60 bg-theme-surface/40 px-4 py-3 gap-3">
              <div className="flex-1 min-w-0 w-full flex items-center">
                <CommandInput
                  value={query}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={placeholderText}
                  className="w-full text-base sm:text-sm text-theme-foreground placeholder:text-theme-muted/70 font-sans"
                />
              </div>

              <div className="shrink-0 flex items-center gap-2">
                {loading && <Spinner className="text-theme-muted w-4 h-4" />}
                {query ? (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="p-1.5 rounded-lg text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-colors cursor-pointer"
                    title={m.search_clear()}
                  >
                    <X className="w-4 h-4" />
                  </button>
                ) : (
                  <Kbd className="text-xs uppercase h-5 px-1.5 font-mono">ESC</Kbd>
                )}
              </div>
            </div>

            <CommandList className="flex-1 min-h-[5rem] max-h-[60vh] overflow-y-auto p-2 font-sans space-y-1">
              {query.trim() === '' ? (
                <>
                  <SearchRecentGroup
                    recentSearches={recentSearches}
                    selectedIndex={selectedIndex}
                    onSelect={handleSelectResult}
                    onHover={setSelectedIndex}
                    onRemove={removeSearch}
                    onClear={clearSearches}
                  />
                  <SearchQuickActions
                    featuredTutorials={featuredTutorials}
                    suggestions={suggestions}
                    selectedIndex={selectedIndex}
                    recentCount={recentSearches.length}
                    onSelect={handleSelectResult}
                    onHover={setSelectedIndex}
                  />
                </>
              ) : (
                <SearchResultSection
                  query={query}
                  loading={loading}
                  results={results}
                  directItems={directItems}
                  docGroups={docGroups}
                  bundleItems={bundleItems}
                  activeItemList={activeItemList}
                  selectedIndex={selectedIndex}
                  onSelect={handleSelectResult}
                  onHover={setSelectedIndex}
                />
              )}
            </CommandList>

            <CommandFooter className="shrink-0 border-t border-theme-border/40 px-4 py-2.5 bg-theme-surface/40 flex items-center justify-between text-xs text-theme-muted font-sans">
              <span className="truncate text-theme-muted/80 text-xs">
                {m.search_footer_hint()}
              </span>

              <div className="flex items-center gap-3 shrink-0 font-mono text-xs">
                <span className="flex items-center gap-1">
                  <Kbd className="h-4.5 px-1.5 text-xs font-mono">↑</Kbd>
                  <Kbd className="h-4.5 px-1.5 text-xs font-mono">↓</Kbd>
                  <span className="text-theme-muted/70">{m.search_footer_switch()}</span>
                </span>
                <span className="flex items-center gap-1">
                  <Kbd className="h-4.5 px-1.5 text-xs font-mono">↵</Kbd>
                  <span className="text-theme-muted/70">{m.search_footer_select()}</span>
                </span>
                <span className="flex items-center gap-1">
                  <Kbd className="h-4.5 px-1.5 text-xs font-mono">ESC</Kbd>
                  <span className="text-theme-muted/70">{m.common_close()}</span>
                </span>
              </div>
            </CommandFooter>
          </CommandPanel>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
