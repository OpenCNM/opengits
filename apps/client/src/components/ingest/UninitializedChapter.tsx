'use client';

import React, { useEffect, useState, useRef, useSyncExternalStore } from 'react';
import { useIngestQueue } from './IngestQueueContext';
import { Loader2, Sparkles, AlertTriangle, RefreshCw, Clock, Pause, Play, CheckCircle2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { MODULE_ROLE_PATTERNS } from '@/engine/language-map';
import { ApiClientError } from '@/lib/api/client';
import { useDocumentStore } from '@/lib/stores/document-store';
import { matchDocPath } from '@/lib/stores/ingest-queue-store';
import { useModalStore } from '@/lib/stores/modal-store';
import { toastManager } from '@/components/ui/toast';
import { STORAGE_KEYS } from '@/lib/constants';
import { evaluateChapterTranscriptionHealth } from '@/lib/ingest/chapter-health';
import { decodeStructuredDbError, type UpstreamErrorMeta } from '@/lib/llm-gateway/upstream-error';
import { resolveUpstreamErrorPresentation } from '@/lib/llm-gateway/upstream-error-ui';
import { UpstreamErrorNotice } from '@/components/common/UpstreamErrorNotice';
import * as m from '@/paraglide/messages';

interface UninitializedChapterProps {
  docId: string;
  docPath: string;
  docTitle?: string | null;
  edition?: string;
  initialStartedAt?: number | null;
  initialProgress?: number | null;
  initialStep?: string | null;
}

const chapterStartTimes = new Map<string, number>();

function resolveChapterStartTime(docId: string, serverStartedAt?: number | null): number {
  if (serverStartedAt && serverStartedAt > 0) {
    chapterStartTimes.set(docId, serverStartedAt);
    if (typeof window !== 'undefined') {
      try {
        sessionStorage.setItem(STORAGE_KEYS.CHAPTER_START_TIME(docId), String(serverStartedAt));
      } catch {}
    }
    return serverStartedAt;
  }

  const inMemory = chapterStartTimes.get(docId);
  if (inMemory && inMemory > 0) {
    return inMemory;
  }

  if (typeof window !== 'undefined') {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEYS.CHAPTER_START_TIME(docId));
      if (stored) {
        const parsed = Number(stored);
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= Date.now()) {
          chapterStartTimes.set(docId, parsed);
          return parsed;
        }
      }
    } catch {}
  }

  const now = Date.now();
  chapterStartTimes.set(docId, now);
  if (typeof window !== 'undefined') {
    try {
      sessionStorage.setItem(STORAGE_KEYS.CHAPTER_START_TIME(docId), String(now));
    } catch {}
  }
  return now;
}

const subscribeOnlineStatus = (callback: () => void) => {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
};

const getOfflineSnapshot = () => (typeof navigator !== 'undefined' ? !navigator.onLine : false);
const getOfflineServerSnapshot = () => false;

export default function UninitializedChapter({
  docId,
  docPath,
  docTitle,
  initialStartedAt,
  initialProgress,
  initialStep,
}: UninitializedChapterProps) {
  useEffect(() => {
    useDocumentStore.getState().setDocumentContext({
      documentId: docId,
      repositoryId: null,
      isTranscribed: false,
    });
    return () => {
      useDocumentStore.getState().clearDocumentContext(docId);
    };
  }, [docId]);

  const { prioritize, documents, processingDocIds, currentProcessingId, isPaused, pause, resume, refreshStatus } = useIngestQueue();
  const router = useRouter();
  const [loadError, setLoadError] = useState<string | UpstreamErrorMeta | null>(null);
  const isOffline = useSyncExternalStore(
    subscribeOnlineStatus,
    getOfflineSnapshot,
    getOfflineServerSnapshot
  );
  const [isReady, setIsReady] = useState(false);
  const refreshedRef = useRef(false);

  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [liveProgress, setLiveProgress] = useState<number | null>(initialProgress ?? null);
  const [liveStep, setLiveStep] = useState<string | null>(initialStep ?? null);
  const [isStalled, setIsStalled] = useState(false);
  const lastActivityAtRef = useRef<number>(Date.now());
  const serverUpdatedAtMsRef = useRef<number | null>(null);
  const lastStepRef = useRef<string>(initialStep || '');
  const lastProgressRef = useRef<number>(initialProgress ?? 0);

  const doc = documents.find((d) => d.id === docId) || documents.find((d) => matchDocPath(d.path, docPath));
  const job = doc?.transcriptionJob ?? null;
  const hasCheckpoints = !!job && job.savedChunks > 0;
  const effectiveStatus = liveStatus || doc?.status || 'UNPROCESSED';
  const hasActiveRepoSibling =
    processingDocIds.some((id) => id !== docId) ||
    Boolean(currentProcessingId && currentProcessingId !== docId) ||
    documents.some(
      (d) =>
        d.id !== docId &&
        (d.status === 'PROCESSING' ||
          d.transcriptionJob?.status === 'RUNNING' ||
          d.transcriptionJob?.status === 'QUEUED')
    );
  const hasActiveRepoSiblingRef = useRef(hasActiveRepoSibling);
  hasActiveRepoSiblingRef.current = hasActiveRepoSibling;
  const jobStatusRef = useRef<string | null>(job?.status ?? null);
  jobStatusRef.current = job?.status ?? null;
  const isQueued =
    job?.status === 'QUEUED' ||
    (effectiveStatus !== 'PROCESSING' && effectiveStatus !== 'PROCESSED' && effectiveStatus !== 'ERROR' && hasActiveRepoSibling);
  const aheadCount = typeof job?.queuePosition === 'number' ? Math.max(0, job.queuePosition - 1) : null;
  const etaSeconds = typeof job?.etaSeconds === 'number' ? job.etaSeconds : null;

  const effectiveStartedAt = initialStartedAt ?? job?.startedAt;
  const currentProgress = liveProgress ?? (typeof job?.progress === 'number' ? job.progress : initialProgress);
  const currentStep = liveStep || job?.step || initialStep;

  const [elapsedMs, setElapsedMs] = useState<number>(() => {
    const startTime = resolveChapterStartTime(docId, effectiveStartedAt);
    return Math.max(0, Date.now() - startTime);
  });
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (effectiveStartedAt && effectiveStartedAt > 0) {
      chapterStartTimes.set(docId, effectiveStartedAt);
      if (typeof window !== 'undefined') {
        try {
          sessionStorage.setItem(STORAGE_KEYS.CHAPTER_START_TIME(docId), String(effectiveStartedAt));
        } catch {}
      }
      setElapsedMs(Math.max(0, Date.now() - effectiveStartedAt));
    }
  }, [docId, effectiveStartedAt]);
  const [resumeBusy, setResumeBusy] = useState(false);
  const handleResumeFromCheckpoint = async () => {
    if (resumeBusy) return;
    setResumeBusy(true);
    try {
      const { api } = await import('@/lib/api/client');
      await api.post(`/api/transcription/${docId}/resume`, {});
      await refreshStatus();
      setLoadError(null);
    } catch (err: unknown) {
      if (err instanceof ApiClientError) {
        setLoadError(
          err.meta ?? {
            code: err.code,
            upstreamStatus: err.status,
            upstreamMessage: err.detail || err.message,
          }
        );
      } else if (err instanceof Error && err.message) {
        setLoadError(err.message);
      }
    } finally {
      setResumeBusy(false);
    }
  };

  const handleRetryInit = () => {
    setLoadError(null);
    const now = Date.now();
    chapterStartTimes.set(docId, now);
    if (typeof window !== 'undefined') {
      try {
        sessionStorage.setItem(STORAGE_KEYS.CHAPTER_START_TIME(docId), String(now));
      } catch {}
    }
    setElapsedMs(0);
    void prioritize(docId).then((accepted) => {
      if (!accepted) {
        toastManager.add({ type: 'error', title: m.toast_action_failed() });
        setLoadError(m.toast_action_failed());
      }
    });
  };

  const handleModelSwitched = () => {
    if (hasCheckpoints) {
      void handleResumeFromCheckpoint();
    } else {
      handleRetryInit();
    }
  };

  const [restartBusy, setRestartBusy] = useState(false);
  const handleForceRestart = async () => {
    if (restartBusy) return;
    setRestartBusy(true);
    try {
      const { api } = await import('@/lib/api/client');
      await api.post(`/api/documents/${docId}/reset`, { force: true }, { onUnauthorized: 'throw' });
      chapterStartTimes.delete(docId);
      if (typeof window !== 'undefined') {
        try {
          sessionStorage.removeItem(STORAGE_KEYS.CHAPTER_START_TIME(docId));
        } catch {}
      }
      setElapsedMs(0);
      setLoadError(null);
      setIsStalled(false);
      setLiveStatus(null);
      setLiveProgress(null);
      setLiveStep(null);
      lastActivityAtRef.current = Date.now();
      serverUpdatedAtMsRef.current = null;
      lastStepRef.current = '';
      lastProgressRef.current = 0;
      const accepted = await prioritize(docId);
      if (!accepted) {
        setLoadError(m.toast_action_failed());
        return;
      }
      await refreshStatus();
    } catch (e: any) {
      console.error('Failed to force restart chapter transcription:', e);
      setLoadError(e?.meta ?? (e?.message || m.chapter_init_failed()));
    } finally {
      setRestartBusy(false);
    }
  };

  useEffect(() => {
    if (isPaused || isReady) return;

    let mounted = true;
    let pollTimer: NodeJS.Timeout | null = null;

    const poll = async () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      try {
        const { api } = await import('@/lib/api/client');
        const res = await api.get<{
          status: string;
          errorMessage: string | null;
          errorMeta?: UpstreamErrorMeta | null;
          progress: number;
          step: string;
          progressInfo: { progress: number; step: string; updatedAt?: string } | null;
        }>(`/api/documents/${docId}/status`, { toastOnError: false, onUnauthorized: 'throw' });

        if (!mounted || !res) return;

        if (res.status === 'PROCESSED') {
          chapterStartTimes.delete(docId);
          if (typeof window !== 'undefined') {
            try {
              sessionStorage.removeItem(STORAGE_KEYS.CHAPTER_START_TIME(docId));
            } catch {}
          }
          if (!refreshedRef.current) {
            refreshedRef.current = true;
            setIsReady(true);
            router.refresh();
          }
          return;
        }

        if (res.status === 'ERROR') {
          setLoadError(res.errorMeta ?? (res.errorMessage || ''));
          return;
        }

        setLoadError(null);
        setLiveStatus(res.status);

        if (typeof res.progress === 'number') {
          setLiveProgress(res.progress);
        }
        if (res.step) {
          setLiveStep(res.step);
        }

        const parsedServerMs = res.progressInfo?.updatedAt ? new Date(res.progressInfo.updatedAt).getTime() : NaN;
        const serverUpdatedAtMs = Number.isFinite(parsedServerMs) && parsedServerMs > 0 ? parsedServerMs : null;
        if (serverUpdatedAtMs !== null) {
          serverUpdatedAtMsRef.current = serverUpdatedAtMs;
        }

        const now = Date.now();
        const hasStepChanged = res.step !== lastStepRef.current || res.progress !== lastProgressRef.current;
        if (hasStepChanged) {
          lastActivityAtRef.current = now;
          lastStepRef.current = res.step;
          lastProgressRef.current = res.progress;
        }

        const verdict = evaluateChapterTranscriptionHealth({
          docStatus: res.status,
          jobStatus: jobStatusRef.current,
          hasActiveRepoSibling: hasActiveRepoSiblingRef.current,
          serverUpdatedAtMs: serverUpdatedAtMsRef.current,
          fallbackActivityMs: lastActivityAtRef.current,
          nowMs: now,
        });
        setIsStalled(verdict.isStalled);
      } catch {
        const verdict = evaluateChapterTranscriptionHealth({
          docStatus: effectiveStatus,
          jobStatus: jobStatusRef.current,
          hasActiveRepoSibling: hasActiveRepoSiblingRef.current,
          serverUpdatedAtMs: serverUpdatedAtMsRef.current,
          fallbackActivityMs: lastActivityAtRef.current,
          nowMs: Date.now(),
        });
        setIsStalled(verdict.isStalled);
      }
    };

    pollTimer = setInterval(poll, 2500);
    void poll();

    return () => {
      mounted = false;
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [docId, isPaused, isReady, router]);

  const displayTitle = docTitle || doc?.title || docPath.split('/').pop() || m.chapter_untitled();

  const numMatch = (docPath.split('/').pop() || docPath).match(MODULE_ROLE_PATTERNS.numericPrefixPattern);
  const chapterNum = numMatch ? parseInt(numMatch[1], 10) : 1;
  const estimatedWords = 2500 + (chapterNum * 450) % 2000;

  useEffect(() => {
    if (isPaused || isReady) return;

    const tick = () => {
      const currentStart = chapterStartTimes.get(docId) ?? resolveChapterStartTime(docId, effectiveStartedAt);
      setElapsedMs(Math.max(0, Date.now() - currentStart));
    };

    timerRef.current = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      tick();
    }, 100);

    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isPaused, isReady, docId, effectiveStartedAt]);

  useEffect(() => {
    if (
      !isPaused &&
      !isReady &&
      doc?.status !== 'PROCESSING' &&
      doc?.transcriptionJob?.status !== 'RUNNING' &&
      doc?.status !== 'PROCESSED'
    ) {
      void prioritize(docId).then((accepted) => {
        if (!accepted) {
          setLoadError((prev) => prev ?? m.toast_action_failed());
        }
      });
    }
  }, [docId, prioritize, isPaused, isReady, doc?.status, doc?.transcriptionJob?.status]);

  useEffect(() => {
    if (doc?.status === 'PROCESSED') {
      chapterStartTimes.delete(docId);
      if (typeof window !== 'undefined') {
        try {
          sessionStorage.removeItem(STORAGE_KEYS.CHAPTER_START_TIME(docId));
        } catch {}
      }
      if (!refreshedRef.current) {
        refreshedRef.current = true;
        setIsReady(true);
        router.refresh();
      }
    }
  }, [doc, docId, router]);

  useEffect(() => {
    if (isReady && typeof window !== 'undefined') {
      const reloadKey = `uninit_hard_reload_${docId}`;
      const lastReload = Number(sessionStorage.getItem(reloadKey) || '0');
      const now = Date.now();

      if (now - lastReload < 15000) {
        return;
      }

      const timer = setTimeout(() => {
        try {
          sessionStorage.setItem(reloadKey, String(Date.now()));
        } catch {}
        window.location.reload();
      }, 3500);
      return () => clearTimeout(timer);
    }
  }, [isReady, docId]);

  const formatTimer = (ms: number) => {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60).toString().padStart(2, '0');
    const secs = (totalSecs % 60).toString().padStart(2, '0');
    const tenths = Math.floor((ms % 1000) / 100);
    return `${mins}:${secs}.${tenths}`;
  };

  const getNarrativeText = (ms: number, queued: boolean, paused: boolean, hasCheckpointProgress: boolean) => {
    if (paused) return m.uninitialized_chapter_paused();
    if (queued) return m.uninitialized_chapter_narrative_queued();
    if (hasCheckpointProgress) return m.uninitialized_chapter_narrative_polishing();
    const secs = ms / 1000;
    if (secs < 15) return m.uninitialized_chapter_narrative_context();
    if (secs < 45) return m.uninitialized_chapter_narrative_structuring();
    return m.uninitialized_chapter_narrative_polishing();
  };

  if (isReady) {
    return (
      <div className="flex flex-col items-center justify-center p-8 max-w-xl mx-auto my-8 relative rounded-3xl border border-theme-border bg-theme-bg shadow-sm transition-all select-none">
        <div className="relative z-10 flex flex-col items-center gap-3 text-center py-8">
          <div className="p-3.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 animate-pulse">
            <CheckCircle2 size={32} />
          </div>
          <h2 className="text-lg font-bold text-theme-foreground">
            {m.uninitialized_chapter_ready_loading()}
          </h2>
          <p className="text-xs text-theme-muted">
            {displayTitle}
          </p>
        </div>
      </div>
    );
  }

  const docError: string | UpstreamErrorMeta | null =
    doc?.status === 'ERROR'
      ? (decodeStructuredDbError(doc.errorMessage) ?? (doc.errorMessage || ''))
      : null;
  const effectiveLoadError =
    loadError && typeof loadError === 'object'
      ? loadError
      : docError && typeof docError === 'object'
        ? docError
        : loadError ?? docError;

  const errorPresentation =
    effectiveLoadError !== null
      ? resolveUpstreamErrorPresentation(effectiveLoadError, {
          offline: isOffline,
          fallbackTitle: m.uninitialized_chapter_abnormal(),
          fallbackDesc: m.chapter_init_failed(),
        })
      : null;

  return (
    <div className="flex flex-col items-center justify-center p-8 max-w-xl mx-auto my-8 relative rounded-3xl border border-theme-border bg-theme-bg shadow-sm transition-all select-none">
      <div className="absolute inset-0 bg-gradient-to-b from-amber-500/5 via-transparent to-transparent pointer-events-none rounded-3xl" />

      {errorPresentation ? (
        <UpstreamErrorNotice
          variant="card"
          isOffline={isOffline}
          error={errorPresentation}
          className="relative z-10 w-full border-0 bg-transparent shadow-none p-0 sm:p-2"
          onRetry={handleRetryInit}
          retryLabel={m.uninitialized_chapter_retry_init()}
          onModelSwitched={handleModelSwitched}
          onOpenPreferencesModal={() => {
            useModalStore.getState().openPreferencesModal('llm');
          }}
          onOpenApiKeyModal={() => {
            useModalStore.getState().openApiKeyModal({
              contextText:
                errorPresentation.code === 'KEY_DECRYPT_FAILED'
                  ? m.toast_key_decrypt_failed_desc()
                  : m.toast_missing_api_key(),
              onCompleted: () => {
                handleModelSwitched();
              },
            });
          }}
          extraInfo={
            hasCheckpoints && job?.totalChunks ? (
              <p className="text-caption font-mono text-theme-primary font-semibold">
                {m.uninitialized_chapter_checkpoint_progress({ saved: job.savedChunks, total: job.totalChunks })}
              </p>
            ) : undefined
          }
          extraActions={
            hasCheckpoints ? (
              <button
                type="button"
                disabled={resumeBusy}
                onClick={handleResumeFromCheckpoint}
                className="inline-flex items-center justify-center gap-1.5 text-xs font-medium bg-theme-primary text-theme-primary-fg hover:opacity-90 transition-all cursor-pointer font-serif shadow-2xs px-3.5 py-1.5 rounded-lg disabled:opacity-60"
              >
                <Play size={13} />
                <span>{m.uninitialized_chapter_resume_transcription()}</span>
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="relative z-10 w-full flex flex-col items-center text-center max-w-sm mx-auto">

          <div className="relative mb-6 mt-4">
            {isPaused ? (
              <button
                type="button"
                onClick={resume}
                className="relative z-10 flex items-center justify-center w-24 h-24 rounded-full bg-theme-primary hover:opacity-90 text-theme-primary-fg shadow-xl hover:shadow-2xl hover:scale-105 active:scale-95 transition-all cursor-pointer ring-8 ring-theme-primary/20"
                title={m.uninitialized_chapter_resume_generating()}
              >
                <Play size={44} className="fill-current translate-x-1" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => pause('immediate')}
                className="relative z-10 flex items-center justify-center w-24 h-24 rounded-full bg-theme-bg border-2 border-theme-primary/30 hover:border-theme-primary/60 text-theme-primary shadow-md hover:shadow-lg transition-all cursor-pointer group"
                title={m.uninitialized_chapter_pause_generating()}
              >
                <div className="absolute inset-0 rounded-full border border-theme-primary/40 animate-ping opacity-75 pointer-events-none" />
                <Loader2 size={36} className="animate-spin group-hover:opacity-0 transition-opacity absolute" />
                <Pause size={36} className="opacity-0 group-hover:opacity-100 transition-opacity text-theme-primary absolute" />
              </button>
            )}
          </div>

          <div className="text-center mb-10 w-full">
            <h2 suppressHydrationWarning className="text-xl font-serif font-bold text-theme-foreground mb-2">
              {isPaused
                ? m.uninitialized_chapter_paused()
                : isQueued
                ? m.status_queued()
                : m.uninitialized_chapter_generating()}
            </h2>
            <div className="text-xs text-theme-muted flex items-center justify-center gap-2">
              <span className="font-medium text-theme-foreground truncate max-w-[200px]">{displayTitle}</span>
              <span>·</span>
              <span>{m.uninitialized_chapter_approx_words({ words: estimatedWords.toLocaleString() })}</span>
            </div>

            {!isPaused && !isQueued && (
              <div
                suppressHydrationWarning
                className="mt-3 text-caption font-mono text-theme-primary font-semibold"
              >
                {formatTimer(elapsedMs)}
              </div>
            )}

            {isQueued && !isPaused && (
              <div suppressHydrationWarning className="mt-3 flex flex-col items-center gap-1 text-caption">
                {aheadCount !== null && aheadCount > 0 && (
                  <span className="text-theme-muted">
                    {m.uninitialized_chapter_queue_ahead({ count: aheadCount })}
                  </span>
                )}
                {etaSeconds !== null && (
                  <span className="text-theme-primary font-semibold">
                    {etaSeconds < 60
                      ? m.uninitialized_chapter_eta_soon()
                      : m.uninitialized_chapter_eta_finish({ minutes: Math.ceil(etaSeconds / 60) })}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="relative w-full px-2 flex flex-col items-center gap-3">
            <div className="w-full bg-theme-surface/70 border border-theme-border/60 rounded-2xl p-4 flex flex-col gap-3 shadow-2xs transition-all duration-300">
              <div className="flex items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2 min-w-0 flex-1 text-left">
                  {!isPaused && !isQueued ? (
                    <Sparkles size={14} className="text-theme-primary animate-pulse shrink-0" />
                  ) : isQueued ? (
                    <Clock size={14} className="text-theme-muted shrink-0" />
                  ) : (
                    <Pause size={14} className="text-amber-700 shrink-0" />
                  )}
                  <span suppressHydrationWarning className="font-medium text-theme-foreground truncate leading-relaxed">
                    {currentStep || getNarrativeText(elapsedMs, isQueued, isPaused, hasCheckpoints)}
                  </span>
                </div>

                {hasCheckpoints && job?.totalChunks && job.totalChunks > 0 ? (
                  <span className="font-mono text-xs font-semibold text-theme-primary shrink-0">
                    {m.uninitialized_chapter_checkpoint_progress({ saved: job.savedChunks, total: job.totalChunks })}
                  </span>
                ) : typeof currentProgress === 'number' && currentProgress > 0 ? (
                  <span className="font-mono text-xs font-semibold text-theme-primary shrink-0">
                    {Math.min(100, Math.round(currentProgress))}%
                  </span>
                ) : null}
              </div>

              {hasCheckpoints && job?.totalChunks && job.totalChunks > 0 ? (
                <div className="w-full h-1.5 bg-theme-border/40 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-theme-primary transition-all duration-500 rounded-full"
                    style={{ width: `${Math.min(100, Math.round((job.savedChunks / job.totalChunks) * 100))}%` }}
                  />
                </div>
              ) : typeof currentProgress === 'number' && currentProgress > 0 ? (
                <div className="w-full h-1.5 bg-theme-border/40 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-theme-primary transition-all duration-500 rounded-full"
                    style={{ width: `${Math.min(100, Math.round(currentProgress))}%` }}
                  />
                </div>
              ) : !isPaused && !isQueued ? (
                <div className="w-full h-1.5 bg-theme-border/30 rounded-full overflow-hidden relative">
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-theme-primary/60 to-transparent animate-pulse" />
                </div>
              ) : null}
            </div>

            {isStalled && !isPaused && !isQueued && !isReady && (
              <div className="w-full bg-theme-surface border border-theme-border/80 rounded-2xl p-3.5 flex items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2 text-left text-theme-muted">
                  <AlertTriangle size={15} className="shrink-0 text-theme-accent" />
                  <span>{m.uninitialized_chapter_stalled_tip()}</span>
                </div>
                <button
                  type="button"
                  disabled={restartBusy}
                  onClick={handleForceRestart}
                  className="shrink-0 px-3 py-1.5 text-xs font-semibold rounded-xl bg-theme-primary hover:opacity-90 text-theme-primary-fg transition-opacity cursor-pointer flex items-center gap-1.5 shadow-xs disabled:opacity-60"
                >
                  <RefreshCw size={12} className={restartBusy ? 'animate-spin' : ''} />
                  <span>{m.uninitialized_chapter_retry_init()}</span>
                </button>
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center justify-center">
            <button
              type="button"
              disabled={restartBusy}
              onClick={handleForceRestart}
              className="text-xs text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer flex items-center gap-1.5 disabled:opacity-50 py-1 px-2"
            >
              <RefreshCw size={12} className={restartBusy ? 'animate-spin' : ''} />
              <span>{m.uninitialized_chapter_force_restart()}</span>
            </button>
          </div>

        </div>
      )}
    </div>
  );
}
