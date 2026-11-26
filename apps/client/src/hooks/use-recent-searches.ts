import { useState, useCallback } from 'react';
import { STORAGE_KEYS } from '@/lib/constants';

const RECENT_SEARCHES_KEY = STORAGE_KEYS.RECENT_SEARCHES;
const MAX_RECENT_SEARCHES = 4;

function loadRecentSearchesFromStorage(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const saved = localStorage.getItem(RECENT_SEARCHES_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT_SEARCHES) : [];
  } catch {
    return [];
  }
}

export function useRecentSearches() {
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  const reload = useCallback(() => {
    setRecentSearches(loadRecentSearchesFromStorage());
  }, []);

  const addSearch = useCallback((query: string) => {
    if (typeof window === 'undefined' || !query.trim()) return;
    try {
      const list = loadRecentSearchesFromStorage().filter(
        (q) => q.toLowerCase() !== query.trim().toLowerCase()
      );
      list.unshift(query.trim());
      const nextList = list.slice(0, MAX_RECENT_SEARCHES);
      localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(nextList));
      setRecentSearches(nextList);
    } catch {
    }
  }, []);

  const removeSearch = useCallback((indexToRemove: number) => {
    if (typeof window === 'undefined') return;
    try {
      const updated = loadRecentSearchesFromStorage().filter((_, i) => i !== indexToRemove);
      localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
      setRecentSearches(updated);
    } catch {
    }
  }, []);

  const clearSearches = useCallback(() => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.removeItem(RECENT_SEARCHES_KEY);
      setRecentSearches([]);
    } catch {
    }
  }, []);

  return {
    recentSearches,
    reload,
    addSearch,
    removeSearch,
    clearSearches,
  };
}
