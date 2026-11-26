'use client';

import { useState, useEffect, useRef } from 'react';
import type { SearchResultItem } from '@/app/api/search/route';
import { api } from '@/lib/api/client';

export interface FeaturedTutorialItem {
  id: string;
  type: 'featured_tutorial';
  title: string;
  url: string;
}

export interface DocGroup {
  repoKey: string;
  owner?: string;
  repo?: string;
  docs: SearchResultItem[];
}

interface UseDebouncedSearchOptions {
  open: boolean;
  query: string;
  owner?: string;
  repo?: string;
}

export function useDebouncedSearch({ open, query, owner, repo }: UseDebouncedSearchOptions) {
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [featuredTutorials, setFeaturedTutorials] = useState<FeaturedTutorialItem[]>([]);

  const activeAbortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (open) {
      if (featuredTutorials.length === 0) {
        api
          .get<SearchResultItem[]>('/api/search?q=', { onUnauthorized: 'throw' })
          .then((data) => {
            setFeaturedTutorials(
              (Array.isArray(data) ? data : [])
                .filter((r) => r.type === 'featured_tutorial')
                .map((r) => ({ id: r.id, type: 'featured_tutorial' as const, title: r.title, url: r.url }))
            );
          })
          .catch(() => undefined);
      }
    } else {
      setResults([]);
    }
  }, [open, featuredTutorials.length]);

  useEffect(() => {
    if (open && owner && repo) {
      import('@/lib/wasm/binary-search-engine')
        .then(({ getOrLoadSearchEngine }) => getOrLoadSearchEngine(owner, repo))
        .catch(() => undefined);
    }
  }, [open, owner, repo]);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (activeAbortRef.current) {
      activeAbortRef.current.abort();
      activeAbortRef.current = null;
    }

    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }

    const trimmedQuery = query.trim();
    let isCurrent = true;

    const runNetworkSearch = () => {
      setLoading(true);
      timerRef.current = setTimeout(async () => {
        if (!isCurrent) return;
        const controller = new AbortController();
        activeAbortRef.current = controller;

        try {
          const fetchUrl =
            owner && repo
              ? `/api/search?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&q=${encodeURIComponent(trimmedQuery)}`
              : `/api/search?q=${encodeURIComponent(trimmedQuery)}`;

          const data = await api.get<SearchResultItem[]>(fetchUrl, {
            onUnauthorized: 'throw',
            signal: controller.signal,
          });
          if (isCurrent) {
            setResults(Array.isArray(data) ? data : []);
          }
        } catch (err: any) {
          if (err?.name === 'AbortError') return;
          if (isCurrent) {
            console.error('[SearchDialog Error]:', err);
            setResults([]);
          }
        } finally {
          if (isCurrent) {
            setLoading(false);
          }
        }
      }, 150);
    };

    if (owner && repo) {
      import('@/lib/wasm/binary-search-engine')
        .then(({ getOrLoadSearchEngine }) => getOrLoadSearchEngine(owner, repo))
        .then((engine) => {
          if (!isCurrent) return;
          if (engine) {
            const localHits = engine.search(trimmedQuery);
            if (localHits.length > 0) {
              setResults(localHits);
              setLoading(false);
              return;
            }
          }
          runNetworkSearch();
        })
        .catch(() => {
          if (isCurrent) {
            runNetworkSearch();
          }
        });
      return () => {
        isCurrent = false;
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        if (activeAbortRef.current) {
          activeAbortRef.current.abort();
          activeAbortRef.current = null;
        }
      };
    }

    runNetworkSearch();

    return () => {
      isCurrent = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (activeAbortRef.current) {
        activeAbortRef.current.abort();
        activeAbortRef.current = null;
      }
    };
  }, [query, owner, repo]);

  const directItems = results.filter(
    (r) => r.type === 'repository_exists' || r.type === 'repository_import_cta'
  );
  const bundleItems = results.filter((r) => r.type === 'bundle');
  const docItems = results.filter((r) => r.type === 'document');

  const docGroups: DocGroup[] = [];
  const repoMap = new Map<string, SearchResultItem[]>();

  for (const doc of docItems) {
    const key = doc.owner && doc.repo ? `${doc.owner}/${doc.repo}` : '教程文档';
    if (!repoMap.has(key)) {
      repoMap.set(key, []);
    }
    repoMap.get(key)!.push(doc);
  }

  for (const [repoKey, docs] of repoMap.entries()) {
    const first = docs[0];
    docGroups.push({
      repoKey,
      owner: first?.owner,
      repo: first?.repo,
      docs,
    });
  }

  return {
    results,
    loading,
    featuredTutorials,
    directItems,
    bundleItems,
    docGroups,
  };
}
