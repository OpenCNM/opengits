'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { SearchResultItem } from '@/app/api/search/route';
import type { FeaturedTutorialItem } from './useDebouncedSearch';

export interface RecentSearchItem {
  id: string;
  type: 'recent';
  query: string;
}

export interface SuggestionActionItem {
  id: string;
  type: 'suggestion';
  title: string;
  description: string;
  url: string;
}

export type InitialSearchItem = RecentSearchItem | FeaturedTutorialItem | SuggestionActionItem;

interface UseSearchKeyboardNavigationOptions {
  query: string;
  setQuery: (q: string) => void;
  activeItemList: (SearchResultItem | InitialSearchItem)[];
  onOpenChange: (open: boolean) => void;
  addSearch: (query: string) => void;
}

export function useSearchKeyboardNavigation({
  query,
  setQuery,
  activeItemList,
  onOpenChange,
  addSearch,
}: UseSearchKeyboardNavigationOptions) {
  const router = useRouter();
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset selectedIndex whenever item list or query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [activeItemList.length, query]);

  const handleSelectResult = useCallback(
    (item: SearchResultItem | InitialSearchItem) => {
      if ('type' in item && item.type === 'recent') {
        setQuery(item.query);
        return;
      }
      if ('url' in item && item.url) {
        if (query.trim()) {
          addSearch(query.trim());
        }
        onOpenChange(false);
        router.push(item.url);
      }
    },
    [onOpenChange, router, query, addSearch, setQuery]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (activeItemList.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev < activeItemList.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : activeItemList.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeItemList[selectedIndex]) {
        handleSelectResult(activeItemList[selectedIndex]);
      } else if (query.trim()) {
        addSearch(query.trim());
      }
    }
  };

  return {
    selectedIndex,
    setSelectedIndex,
    handleSelectResult,
    handleKeyDown,
  };
}
