'use client';

import React, { createContext, useContext, useEffect, useCallback, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api/client';
import { useReadingProgressStore } from '@/lib/stores/reading-progress-store';

interface ReadingProgressContextType {
  refreshProgress: (overrideEdition?: string) => Promise<void>;
}

const ReadingProgressContext = createContext<ReadingProgressContextType>({
  refreshProgress: async () => {},
});

function ReadingProgressEditionSync({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}) {
  const searchParams = useSearchParams();
  const edition = searchParams?.get('edition') ?? '';
  const { refreshProgress } = useReadingProgress();
  const prevEditionRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevEditionRef.current === null) {
      prevEditionRef.current = edition;
      if (edition) {
        void refreshProgress(edition);
      }
      return;
    }
    if (prevEditionRef.current !== edition) {
      prevEditionRef.current = edition;
      void refreshProgress(edition);
    }
  }, [edition, refreshProgress]);

  return null;
}

export function ReadingProgressProvider({
  owner,
  repo,
  initialChapterScores = {},
  initialOverallProgress = 0,
  children,
}: {
  owner: string;
  repo: string;
  initialChapterScores?: Record<string, number>;
  initialOverallProgress?: number;
  children: React.ReactNode;
}) {
  const initScores = useReadingProgressStore((s) => s.initScores);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const activeEditionRef = useRef<string>('');

  const repoKey = `${owner}/${repo}`.toLowerCase();

  // Initialize Zustand store on mount or when props change
  useEffect(() => {
    initScores(initialChapterScores, initialOverallProgress, repoKey);
  }, [initialChapterScores, initialOverallProgress, initScores, repoKey]);

  const fetchLatestProgress = useCallback(async (overrideEdition?: string) => {
    try {
      const targetEdition = overrideEdition !== undefined ? overrideEdition : activeEditionRef.current;
      activeEditionRef.current = targetEdition;
      const editionParam = targetEdition ? `&edition=${encodeURIComponent(targetEdition)}` : '';
      const data = await api.get<{
        chapterScores?: Record<string, number>;
        overallProgress?: number;
      }>(
        `/api/repositories/reading-progress/sync?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}${editionParam}`,
        { onUnauthorized: 'throw' }
      );
      if (data.chapterScores) {
        const targetRepoKey = targetEdition ? `${owner}/${repo}:${targetEdition}`.toLowerCase() : repoKey;
        initScores(data.chapterScores, data.overallProgress || 0, targetRepoKey);
      }
    } catch (err) {
      console.warn('[ReadingProgressContext] Failed to sync progress:', err);
    }
  }, [owner, repo, initScores, repoKey]);

  const scheduleRefresh = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      fetchLatestProgress();
    }, 1000);
  }, [fetchLatestProgress]);

  const syncTriggerVersion = useReadingProgressStore((s) => s.syncTriggerVersion);

  // 当 Zustand 状态中间件收到遥测成功同步时，自动防抖触发刷新，无需 window 全局广播
  useEffect(() => {
    if (syncTriggerVersion > 0) {
      scheduleRefresh();
    }
  }, [syncTriggerVersion, scheduleRefresh]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  return (
    <ReadingProgressContext.Provider
      value={{
        refreshProgress: fetchLatestProgress,
      }}
    >
      <Suspense fallback={null}>
        <ReadingProgressEditionSync owner={owner} repo={repo} />
      </Suspense>
      {children}
    </ReadingProgressContext.Provider>
  );
}

export function useReadingProgress() {
  return useContext(ReadingProgressContext);
}
