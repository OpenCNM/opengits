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

/**
 * Compute overall progress scoped to a specific repo.
 * Only counts keys prefixed with `repoKey:` to avoid cross-repo pollution.
 */
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

/** 分数键路径归一（与读取侧 getChapterScore 同口径，杜绝「写脏键、读净键」不对称漂移） */
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

      /**
       * Monotonic Merge: merges DB scores with local scores (Math.max).
       * ONLY writes to scoped keys (`repoKey:path`) to prevent cross-repo pollution.
       */
      initScores: (dbScores, dbOverall, repoKey) => {
        const currentLocal = get().chapterScores || {};
        const merged: Record<string, number> = { ...currentLocal };

        for (const [path, dbScore] of Object.entries(dbScores || {})) {
          if (typeof dbScore !== 'number' || !Number.isFinite(dbScore)) continue;
          const clampedScore = Math.min(100, Math.max(0, Math.round(dbScore)));
          const scopedKey = repoKey ? `${repoKey.toLowerCase()}:${path}` : path;

          // Only check the SCOPED key for existing local score.
          // Do NOT check the un-scoped key — it's shared across repos and would leak scores.
          const existingScoped = currentLocal[scopedKey] ?? 0;

          // One-time legacy migration: if scoped key has no data but un-scoped does,
          // AND no other repo has claimed this un-scoped key, use it as seed.
          let legacySeed = 0;
          if (existingScoped === 0 && repoKey) {
            const unscopedVal = currentLocal[path];
            if (unscopedVal !== undefined && unscopedVal > 0) {
              // Check if any OTHER repo already has a scoped key for this path
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
          // Do NOT write to merged[path] — un-scoped keys are legacy read-only
        }

        const validDbOverall =
          typeof dbOverall === 'number' && Number.isFinite(dbOverall)
            ? Math.min(100, Math.max(0, Math.round(dbOverall)))
            : 0;
        const overall = computeRepoOverall(merged, repoKey, validDbOverall);
        set({ chapterScores: merged, overallProgress: Math.max(validDbOverall, overall) });
      },

      /**
       * Set a chapter score. Only writes to the scoped key.
       * Score is monotonic (never decreases) and clamped to [0, 100].
       */
      setChapterScore: (docPath, score, repoKey) => {
        if (!docPath || typeof score !== 'number' || !Number.isFinite(score)) return;
        const currentScores = get().chapterScores || {};
        const cleanPath = cleanDocPathKey(docPath);
        const scopedKey = repoKey ? `${repoKey.toLowerCase()}:${cleanPath}` : cleanPath;

        const clampedScore = Math.min(100, Math.max(0, Math.round(score)));
        const existing = currentScores[scopedKey] ?? 0;
        const newScore = Math.max(existing, clampedScore);

        // Avoid unnecessary updates if score did not change
        if (currentScores[scopedKey] === newScore) return;

        const updated = {
          ...currentScores,
          [scopedKey]: newScore,
          // Do NOT write to [docPath] — un-scoped keys are legacy read-only
        };

        const overall = computeRepoOverall(updated, repoKey, get().overallProgress);
        set({ chapterScores: updated, overallProgress: overall });
      },

      /**
       * Get a chapter score. Checks scoped key first, then falls back to
       * un-scoped legacy key (read-only backward compatibility).
       *
       * 讲法强隔离：带 :edition 后缀的 repoKey 不再穿透回基础仓分数——
       * 服务端 sync（/v1/reading/progress-sync）本就按讲法行严格隔离，
       * 客户端 read-through 回退恰是与服务端语义相悖的异类（同一目录下
       * 混显基础分+讲法分）。每讲法进度从 0 起算，读写完全对称。
       */
      getChapterScore: (docPath, repoKey) => {
        if (!docPath) return 0;
        const currentScores = get().chapterScores || {};
        const cleanPath = docPath.trim().replace(/^\/+/, '');

        // 1. Scoped key (authoritative)
        if (repoKey) {
          const scopedKey = `${repoKey.toLowerCase()}:${cleanPath}`;
          if (currentScores[scopedKey] !== undefined) return currentScores[scopedKey];

          const rawScopedKey = `${repoKey.toLowerCase()}:${docPath}`;
          if (currentScores[rawScopedKey] !== undefined) return currentScores[rawScopedKey];
        }

        // 2. Un-scoped legacy key (read-only fallback for old data)
        return currentScores[cleanPath] ?? currentScores[docPath] ?? 0;
      },

      /**
       * Completely purge chapter scores for a target repo (or ALL repos if repoKey is omitted).
       */
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

// Cross-Tab Monotonic Synchronization: Merge chapterScores with Math.max on storage events
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
        // ignore parse errors
      }
    }
  });
}
