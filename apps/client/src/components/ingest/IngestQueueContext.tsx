'use client';

import React, { createContext, useContext, useEffect, useRef, useMemo, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useShallow } from 'zustand/react/shallow';
import { DocumentStatus, STORAGE_KEYS } from '@/lib/constants';
import { api } from '@/lib/api/client';
import {
  QueuedDocument,
  useIngestQueueStore,
  normalizeDocPath,
  selectTranscriptionProjection,
  type TranscriptionQueueProjection,
} from '@/lib/stores/ingest-queue-store';
import type { RepositoryEditionOption } from '@/lib/repository-resolver';
import { memoizeOne, createMemoizedSelector, shallowArrayEqual } from '@/lib/stores/memoize-selector';
import { projectPublishIntent } from '@/lib/state/publish-intent-projector';

interface IngestQueueContextType {
  documents: QueuedDocument[];
  owner: string;
  repo: string;
  edition: string;
  availableEditions: RepositoryEditionOption[];
  isPaused: boolean;
  pauseMode: 'immediate' | 'after_chapter' | null;
  processingDocIds: string[];
  currentProcessingId: string | null;
  prioritizedId: string | null;
  progress: { processed: number; total: number };
  repositoryId: string | null;
  isPublic: boolean;
  reviewStatus: string | null;
  publishedAt: string | null;
  transcriptionCreditsEarned: number;
  transcriptionTokens: number;
  publishRequested: boolean;
  pause: (mode?: 'immediate' | 'after_chapter') => void;
  resume: () => void;
  prioritize: (docId: string) => Promise<boolean>;
  regenerate: (docId: string) => Promise<void>;
  refreshStatus: () => Promise<void>;
}

const IngestQueueContext = createContext<IngestQueueContextType | undefined>(undefined);

function IngestQueueEditionSync({
  owner,
  repo,
  initialEditions,
}: {
  owner: string;
  repo: string;
  initialEditions?: RepositoryEditionOption[];
}) {
  const searchParams = useSearchParams();
  const edition = searchParams?.get('edition') ?? '';
  const initRepo = useIngestQueueStore((s) => s.initRepo);
  const refreshStatus = useIngestQueueStore((s) => s.refreshStatus);

  useEffect(() => {
    initRepo(owner, repo, edition, initialEditions);
    void refreshStatus(edition);
  }, [owner, repo, edition, initRepo, refreshStatus, initialEditions]);

  return null;
}

export function IngestQueueProvider({
  children,
  owner,
  repo,
  initialEditions,
  liveUpdates = true,
}: {
  children: React.ReactNode;
  owner: string;
  repo: string;
  initialEditions?: RepositoryEditionOption[];
  liveUpdates?: boolean;
}) {
  const router = useRouter();

  const storeOwner = useIngestQueueStore((s) => s.owner);
  const storeRepo = useIngestQueueStore((s) => s.repo);
  const edition = useIngestQueueStore((s) => s.edition);
  const availableEditions = useIngestQueueStore((s) => s.availableEditions);
  const documents = useIngestQueueStore((s) => s.documents);
  const isPaused = useIngestQueueStore((s) => s.isPaused);
  const pauseMode = useIngestQueueStore((s) => s.pauseMode);
  const currentProcessingId = useIngestQueueStore((s) => s.currentProcessingId);
  const prioritizedId = useIngestQueueStore((s) => s.prioritizedId);
  const pause = useIngestQueueStore((s) => s.pause);
  const resume = useIngestQueueStore((s) => s.resume);
  const prioritize = useIngestQueueStore((s) => s.prioritize);
  const regenerate = useIngestQueueStore((s) => s.regenerate);
  const refreshStatus = useIngestQueueStore((s) => s.refreshStatus);
  const repositoryId = useIngestQueueStore((s) => s.repositoryId);
  const isPublic = useIngestQueueStore((s) => s.isPublic);
  const reviewStatus = useIngestQueueStore((s) => s.reviewStatus);
  const publishedAt = useIngestQueueStore((s) => s.publishedAt);
  const transcriptionCreditsEarned = useIngestQueueStore((s) => s.transcriptionCreditsEarned);
  const transcriptionTokens = useIngestQueueStore((s) => s.transcriptionTokens);
  const publishRequested = useIngestQueueStore((s) => s.publishRequested);
  const processingDocIds = useIngestQueueStore((s) => s.processingDocIds);

  const prevPrioritizedRef = useRef<string | null>(null);
  useEffect(() => {
    if (prioritizedId) {
      prevPrioritizedRef.current = prioritizedId;
    } else if (prevPrioritizedRef.current) {
      prevPrioritizedRef.current = null;
      router.refresh();
    }
  }, [prioritizedId, router]);

  const prevEditionsFingerprintRef = useRef<string>('');
  useEffect(() => {
    if (!availableEditions || availableEditions.length === 0) return;
    const currentFingerprint = availableEditions.map((e) => e.id).sort().join(',');
    if (prevEditionsFingerprintRef.current && prevEditionsFingerprintRef.current !== currentFingerprint) {
      router.refresh();
    }
    prevEditionsFingerprintRef.current = currentFingerprint;
  }, [availableEditions, router]);

  useEffect(() => {
    const handlePageHide = () => {
      const pauseOnCloseEnabled = localStorage.getItem(STORAGE_KEYS.INGEST_PAUSE_ON_CLOSE(owner, repo)) === 'true';
      if (pauseOnCloseEnabled) {
        const editionQuery = edition ? `?edition=${encodeURIComponent(edition)}` : '';
        fetch(`/api/ingest/${owner}/${repo}/pause${editionQuery}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused: true }),
          credentials: 'same-origin',
          keepalive: true,
        }).catch(() => {
          navigator.sendBeacon(
            `/api/ingest/${owner}/${repo}/pause${editionQuery}`,
            new Blob([JSON.stringify({ paused: true })], { type: 'application/json' })
          );
        });
      }
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, [owner, repo, edition]);

  const hasPendingWorkRef = useRef(false);
  useEffect(() => {
    hasPendingWorkRef.current = documents.some((d) => d.status !== 'PROCESSED');
  }, [documents]);

  useEffect(() => {
    const ACTIVE_POLL_MS = 10_000;
    const IDLE_POLL_MS = 60_000;
    let lastRefreshAt = Date.now();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const interval = liveUpdates || hasPendingWorkRef.current ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      if (Date.now() - lastRefreshAt >= interval) {
        lastRefreshAt = Date.now();
        void refreshStatus(edition);
      }
    }, ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [owner, repo, edition, refreshStatus, liveUpdates]);

  useEffect(() => {
    if (!owner || !repo || !liveUpdates) return;
    if (storeOwner !== owner || storeRepo !== repo) return;
    let consecutiveErrors = 0;
    const editionParam = edition ? `?edition=${encodeURIComponent(edition)}` : '';
    let source: EventSource | null = new EventSource(`/api/ingest/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/events${editionParam}`);

    let debounceTimer: NodeJS.Timeout | null = null;
    source.addEventListener('ingest', () => {
      consecutiveErrors = 0;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void refreshStatus(edition);
      }, 1000);
    });
    source.onerror = () => {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) {
        source?.close();
        source = null;
      }
    };
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      source?.close();
      source = null;
    };
  }, [owner, repo, storeOwner, storeRepo, edition, refreshStatus, liveUpdates]);

  const ingestProgress = useIngestProgress();

  const hasAutoSubmittedRef = useRef(false);
  useEffect(() => {
    const allProcessed =
      ingestProgress.total > 0 && ingestProgress.processed === ingestProgress.total;
    const publishIntent = projectPublishIntent({
      publishRequested,
      isPublic,
      reviewStatus,
      allProcessed,
    });
    if (publishIntent === 'READY_TO_SUBMIT' && !hasAutoSubmittedRef.current) {
      hasAutoSubmittedRef.current = true;
      api.patch('/api/repos/publish', {
        repoId: repositoryId || undefined,
        owner,
        repo,
        edition: edition || undefined,
      })
        .then(() => refreshStatus(edition))
        .catch((err: unknown) => {
          console.warn('[IngestQueueContext] Auto-publish submission skipped or deferred:', err);
        });
    }
  }, [ingestProgress, publishRequested, isPublic, reviewStatus, owner, repo, edition, repositoryId, refreshStatus]);

  const contextValue = useMemo(
    () => ({
      documents,
      owner,
      repo,
      edition,
      availableEditions,
      isPaused,
      pauseMode,
      processingDocIds,
      currentProcessingId,
      prioritizedId,
      progress: ingestProgress,
      repositoryId,
      isPublic,
      reviewStatus,
      publishedAt,
      transcriptionCreditsEarned,
      transcriptionTokens,
      publishRequested,
      pause,
      resume,
      prioritize,
      regenerate,
      refreshStatus,
    }),
    [
      documents,
      owner,
      repo,
      edition,
      availableEditions,
      isPaused,
      pauseMode,
      processingDocIds,
      currentProcessingId,
      prioritizedId,
      ingestProgress,
      repositoryId,
      isPublic,
      reviewStatus,
      publishedAt,
      transcriptionCreditsEarned,
      transcriptionTokens,
      publishRequested,
      pause,
      resume,
      prioritize,
      regenerate,
      refreshStatus,
    ]
  );

  return (
    <IngestQueueContext.Provider value={contextValue}>
      <Suspense fallback={null}>
        <IngestQueueEditionSync owner={owner} repo={repo} initialEditions={initialEditions} />
      </Suspense>
      {children}
    </IngestQueueContext.Provider>
  );
}

const memoizedProgressResult = memoizeOne(
  (processed: number, total: number) => ({ processed, total }),
  (prev, next) => prev[0] === next[0] && prev[1] === next[1]
);

const selectIngestProgress = createMemoizedSelector(
  (s: { documents: QueuedDocument[] }) => {
    const documents = s.documents || [];
    const total = documents.length;
    const processed = documents.filter((d) => d.status === 'PROCESSED').length;
    return memoizedProgressResult(processed, total);
  },
  (prev, next) => prev.documents === next.documents
);

export function useIngestProgress() {
  return useIngestQueueStore(selectIngestProgress);
}

interface IngestStatusSlice {
  isPaused: boolean;
  pauseMode: 'immediate' | 'after_chapter' | null;
  processingDocIds: string[];
  currentProcessingId: string | null;
  prioritizedId: string | null;
  transcriptionTokens: number;
}

const selectIngestStatus = createMemoizedSelector(
  (s: IngestStatusSlice): IngestStatusSlice => ({
    isPaused: s.isPaused,
    pauseMode: s.pauseMode,
    processingDocIds: s.processingDocIds,
    currentProcessingId: s.currentProcessingId,
    prioritizedId: s.prioritizedId,
    transcriptionTokens: s.transcriptionTokens,
  }),
  (a, b) =>
    a.isPaused === b.isPaused &&
    a.pauseMode === b.pauseMode &&
    a.currentProcessingId === b.currentProcessingId &&
    a.prioritizedId === b.prioritizedId &&
    a.transcriptionTokens === b.transcriptionTokens &&
    shallowArrayEqual(a.processingDocIds, b.processingDocIds)
);

interface IngestActionsSlice {
  pause: (mode?: 'immediate' | 'after_chapter') => void;
  resume: () => void;
  prioritize: (docId: string) => Promise<boolean>;
  regenerate: (docId: string) => Promise<void>;
  refreshStatus: () => Promise<void>;
}

const selectIngestActions = createMemoizedSelector(
  (s: IngestActionsSlice): IngestActionsSlice => ({
    pause: s.pause,
    resume: s.resume,
    prioritize: s.prioritize,
    regenerate: s.regenerate,
    refreshStatus: s.refreshStatus,
  }),
  (a, b) =>
    a.pause === b.pause &&
    a.resume === b.resume &&
    a.prioritize === b.prioritize &&
    a.regenerate === b.regenerate &&
    a.refreshStatus === b.refreshStatus
);

export function useIngestQueue() {
  const context = useContext(IngestQueueContext);
  if (context === undefined) {
    throw new Error('useIngestQueue must be used within an IngestQueueProvider');
  }
  return context;
}
