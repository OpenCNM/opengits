import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface ReadingProgressState {
  chapterScores: Record<string, number>;
  overallProgress: number;
  syncTriggerVersion: number;
  initScores: (scores: Record<string, number>, overall: number, repoKey?: string) => void;
  setChapterScore: (docPath: string, score: number, repoKey?: string) => void;
  getChapterScore: (docPath: string, repoKey?: string) => number;
  clearRepoScores: (repoKey?: string) => void;
  triggerSync: () => void;
}

function computeRepoOverall(
  scores: Record<string, number>,
  repoKey?: string,
  fallbackOverall: number = 0
): number {
  if (!scores || Object.keys(scores).length === 0) return fallbackOverall;

  if (repoKey) {
    const prefix = `${repoKey.toLowerCase()}:`;
    const repoValues = Object.entries(scores)
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v);

    if (repoValues.length > 0) {
      return Math.round(repoValues.reduce((a, b) => a + b, 0) / repoValues.length);
    }
  }

  return fallbackOverall;
}

function cleanDocPathKey(docPath: string): string {
  return docPath.trim().replace(/^\/+/, '');
}

export const useReadingProgressStore = create<ReadingProgressState>()(
  persist(
    (set, get) => ({
      chapterScores: {},
      overallProgress: 0,
      syncTriggerVersion: 0,

      triggerSync: () => {
        set((state) => ({ syncTriggerVersion: state.syncTriggerVersion + 1 }));
      },

      initScores: (dbScores, dbOverall, repoKey) => {
        const currentLocal = get().chapterScores || {};
        const merged: Record<string, number> = { ...currentLocal };

        for (const [path, dbScore] of Object.entries(dbScores || {})) {
          if (typeof dbScore !== 'number' || !Number.isFinite(dbScore)) continue;
          const clampedScore = Math.min(100, Math.max(0, Math.round(dbScore)));
          const scopedKey = repoKey ? `${repoKey.toLowerCase()}:${path}` : path;

          const existingScoped = currentLocal[scopedKey] ?? 0;

          let legacySeed = 0;
          if (existingScoped === 0 && repoKey) {
            const unscopedVal = currentLocal[path];
            if (unscopedVal !== undefined && unscopedVal > 0) {
              const hasOtherRepoKey = Object.keys(currentLocal).some(
                (k) => k.endsWith(`:${path}`) && !k.startsWith(`${repoKey.toLowerCase()}:`)
              );
              if (!hasOtherRepoKey) {
                legacySeed = unscopedVal;
              }
            }
          }

          const finalScore = Math.max(existingScoped, legacySeed, clampedScore);
          merged[scopedKey] = finalScore;
        }

        const validDbOverall =
          typeof dbOverall === 'number' && Number.isFinite(dbOverall)
            ? Math.min(100, Math.max(0, Math.round(dbOverall)))
            : 0;
        const overall = computeRepoOverall(merged, repoKey, validDbOverall);
        set({ chapterScores: merged, overallProgress: Math.max(validDbOverall, overall) });
      },

      setChapterScore: (docPath, score, repoKey) => {
        if (!docPath || typeof score !== 'number' || !Number.isFinite(score)) return;
        const currentScores = get().chapterScores || {};
        const cleanPath = cleanDocPathKey(docPath);
        const scopedKey = repoKey ? `${repoKey.toLowerCase()}:${cleanPath}` : cleanPath;

        const clampedScore = Math.min(100, Math.max(0, Math.round(score)));
        const existing = currentScores[scopedKey] ?? 0;
        const newScore = Math.max(existing, clampedScore);

        if (currentScores[scopedKey] === newScore) return;

        const updated = {
          ...currentScores,
          [scopedKey]: newScore,
        };

        const overall = computeRepoOverall(updated, repoKey, get().overallProgress);
        set({ chapterScores: updated, overallProgress: overall });
      },

      getChapterScore: (docPath, repoKey) => {
        if (!docPath) return 0;
        const currentScores = get().chapterScores || {};
        const cleanPath = docPath.trim().replace(/^\/+/, '');

        if (repoKey) {
          const scopedKey = `${repoKey.toLowerCase()}:${cleanPath}`;
          if (currentScores[scopedKey] !== undefined) return currentScores[scopedKey];

          const rawScopedKey = `${repoKey.toLowerCase()}:${docPath}`;
          if (currentScores[rawScopedKey] !== undefined) return currentScores[rawScopedKey];
        }

        return currentScores[cleanPath] ?? currentScores[docPath] ?? 0;
      },

      clearRepoScores: (repoKey) => {
        const currentScores = get().chapterScores || {};
        if (!repoKey) {
          set({ chapterScores: {}, overallProgress: 0 });
          return;
        }

        const prefix = `${repoKey.toLowerCase()}:`;
        const updated: Record<string, number> = {};
        for (const [k, v] of Object.entries(currentScores)) {
          if (!k.toLowerCase().startsWith(prefix)) {
            updated[k] = v;
          }
        }

        const overall = computeRepoOverall(updated, repoKey, 0);
        set({ chapterScores: updated, overallProgress: overall });
      },
    }),
    {
      name: 'reading-progress-store-v1',
      storage: createJSONStorage(() => {
        if (typeof window !== 'undefined' && window.localStorage) {
          return localStorage;
        }
        return {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
        };
      }),
      partialize: (state) => ({
        chapterScores: state.chapterScores,
        overallProgress: state.overallProgress,
      }),
    }
  )
);

export function shouldPurgeReadingProgressKey(key: string, repoKey?: string | null): boolean {
  if (repoKey) {
    const prefixA = `reading_pos_v2_${repoKey}:`;
    const prefixB = `reading_pos_${repoKey}:`;
    const prefixC = `${repoKey}:`;
    return key.startsWith(prefixA) || key.startsWith(prefixB) || key.startsWith(prefixC);
  }
  return key.startsWith('reading_pos_') || key.startsWith('reading-progress-');
}

export function mergeMonotonicScores(
  current: Record<string, number>,
  incoming: Record<string, unknown>
): { merged: Record<string, number>; hasDiff: boolean } {
  const merged: Record<string, number> = { ...current };
  let hasDiff = false;
  for (const [k, v] of Object.entries(incoming)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (typeof v === 'number' && Number.isFinite(v)) {
      const cur = merged[k] ?? 0;
      const clampedVal = Math.min(100, Math.max(0, Math.round(v)));
      const maxVal = Math.max(cur, clampedVal);
      if (maxVal !== cur) {
        merged[k] = maxVal;
        hasDiff = true;
      }
    }
  }
  return { merged, hasDiff };
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'reading-progress-store-v1' && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue);
        const incoming = parsed?.state?.chapterScores;
        if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
          const current = useReadingProgressStore.getState().chapterScores || {};
          const { merged, hasDiff } = mergeMonotonicScores(current, incoming as Record<string, unknown>);
          if (hasDiff) {
            const incomingOverall =
              typeof parsed?.state?.overallProgress === 'number' && Number.isFinite(parsed.state.overallProgress)
                ? Math.min(100, Math.max(0, Math.round(parsed.state.overallProgress)))
                : 0;
            useReadingProgressStore.setState((prev) => ({
              chapterScores: merged,
              overallProgress: Math.max(prev.overallProgress, incomingOverall),
            }));
          }
        }
      } catch {
      }
    }
  });
}
