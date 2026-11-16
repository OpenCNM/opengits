'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useIngestQueue } from './IngestQueueContext';
import { Loader2, Sparkles, AlertTriangle, RefreshCw, Clock, Pause, Play, CheckCircle2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { MODULE_ROLE_PATTERNS } from '@/engine/language-map';
import { useDocumentStore } from '@/lib/stores/document-store';
import { matchDocPath } from '@/lib/stores/ingest-queue-store';
import { toastManager } from '@/components/ui/toast';
import { STORAGE_KEYS } from '@/lib/constants';
import { evaluateChapterTranscriptionHealth } from '@/lib/ingest/chapter-health';
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

// 模块级物理启动时间戳登记（第一性原理：保护计时器物理单调递增，杜绝 router.refresh 重置时间）
const chapterStartTimes = new Map<string, number>();

/**
 * 解析章节转录物理启动时间戳（第一性原理闭环）：
 * 1. 服务端物理事实优先：若 job.startedAt（基于 claimedAt/createdAt）已下发，作为绝对真理
 * 2. 客户端会话存储兜底：sessionStorage 杜绝 F5/Cmd+R 硬刷新时瞬间闪烁 00:00.0
 * 3. 内存 Map 单例缓存：跨组件重挂与软路由切换保持物理单调递增
 * 4. 首次访问以当前物理时间戳锚定
 */
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

export default function UninitializedChapter({
  docId,
  docPath,
  docTitle,
  initialStartedAt,
  initialProgress,
  initialStep,
}: UninitializedChapterProps) {
  // 标记当前章节处于转录中/未完成态，AI 对话框暂不呈现
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
  const [loadError, setLoadError] = useState<string | null>(null);
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

  // Pick up doc from queue context using deterministic path matching
  const doc = documents.find((d) => d.id === docId) || documents.find((d) => matchDocPath(d.path, docPath));
  // 服务端转录任务概要（断点续接，Phase 3 #9）
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
  // 排队透明化：自身 QUEUED 或处于 UNPROCESSED 且同仓有兄弟章节正在执行时，均属健康排队态
  const isQueued =
    job?.status === 'QUEUED' ||
    (effectiveStatus !== 'PROCESSING' && effectiveStatus !== 'PROCESSED' && effectiveStatus !== 'ERROR' && hasActiveRepoSibling);
  const aheadCount = typeof job?.queuePosition === 'number' ? Math.max(0, job.queuePosition - 1) : null;
  const etaSeconds = typeof job?.etaSeconds === 'number' ? job.etaSeconds : null;

  const effectiveStartedAt = initialStartedAt ?? job?.startedAt;
  const currentProgress = liveProgress ?? (typeof job?.progress === 'number' ? job.progress : initialProgress);
  const currentStep = liveStep || job?.step || initialStep;



  // 物理单调递增计时器：首屏即闭环服务端物理事实与 sessionStorage，杜绝刷新回零
  const [elapsedMs, setElapsedMs] = useState<number>(() => {
    const startTime = resolveChapterStartTime(docId, effectiveStartedAt);
    return Math.max(0, Date.now() - startTime);
  });
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // 服务端真实物理事实变更或到达时（例如异步轮询返回 claimedAt/startedAt），校准客户端时间基准与缓存
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
    } catch {
      setResumeBusy(false);
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
        // 服务端拒绝（限流/虚拟章守卫）：本地已回滚，向读者显式交代而非静默失败
        setLoadError(m.toast_action_failed());
        return;
      }
      await refreshStatus();
    } catch (e: any) {
      console.error('Failed to force restart chapter transcription:', e);
      setLoadError(e.message || m.chapter_init_failed());
    } finally {
      setRestartBusy(false);
    }
  };

  // 实时单章活性与真实心跳流式轮询（断绝“若上游已无响应”的主观猜谜，闭环物理事实）：
  // 每 2.5s 轮询 /api/documents/[id]/status。若字符数递增或 90s 内有 heartbeat 更新，保持活跃；
  // 唯有连续 90s 绝对静默且无推进时，才向读者呈现确定性的超时重新初始化入口。
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
          setLoadError(res.errorMessage || m.chapter_init_failed());
          return;
        }

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

  // Derive chapter title & estimated metadata
  const displayTitle = docTitle || doc?.title || docPath.split('/').pop() || m.chapter_untitled();
  
  // Estimate length based on chapter number / filename
  // 章序估算用数字前缀事实（注册表）：chapterN / lesson-N / 01-basics 等命名一律不再解析语义，
  // 认不出序号统一按第 1 章估（纯 UI 预估，非业务判定）
  const numMatch = (docPath.split('/').pop() || docPath).match(MODULE_ROLE_PATTERNS.numericPrefixPattern);
  const chapterNum = numMatch ? parseInt(numMatch[1], 10) : 1;
  const estimatedWords = 2500 + (chapterNum * 450) % 2000;

  // 1. Live Timer — 保持时间单调连续性，暂停时冻结，恢复时平滑累加。
  // 可见性门控（性能修复 2026-10-13）：后台标签页暂停 100ms 高频计时（整页
  // 10 次/秒重渲染仅为显示 mm:ss.t 倒计时）；回前台时基于绝对时间戳自然追平，
  // 单调连续机制（chapterStartTimes Map 与服务端物理时间戳）不受影响。
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

  // Trigger priority processing on mount
  useEffect(() => {
    // 已有执行者正在处理（PROCESSING / RUNNING）或已就绪 → 无需重复入队，等待状态轮询翻转为 PROCESSED
    if (
      !isPaused &&
      !isReady &&
      doc?.status !== 'PROCESSING' &&
      doc?.transcriptionJob?.status !== 'RUNNING' &&
      doc?.status !== 'PROCESSED'
    ) {
      prioritize(docId);
    }
  }, [docId, prioritize, isPaused, isReady, doc?.status, doc?.transcriptionJob?.status]);

  // Handle errors or completion
  useEffect(() => {
    if (doc) {
      if (doc.status === 'ERROR') {
        setLoadError(doc.errorMessage || m.chapter_init_failed());
      } else if (doc.status === 'PROCESSED') {
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
    }
  }, [doc, docId, router]);

  // 防冻结兜底：若服务端 RSC 未能在 3.5s 内完成热替换，主动硬刷新确保读者进入教程正文。
  // 通过 sessionStorage 记录刷新防抖戳，严防服务端正文延迟落库引发的无限刷新风暴。
  useEffect(() => {
    if (isReady && typeof window !== 'undefined') {
      const reloadKey = `uninit_hard_reload_${docId}`;
      const lastReload = Number(sessionStorage.getItem(reloadKey) || '0');
      const now = Date.now();

      // 15 秒内若已硬刷新过一次，则不再自动刷新，避免无限刷新死循环
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

  // Format elapsed time (00:04.2)
  const formatTimer = (ms: number) => {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60).toString().padStart(2, '0');
    const secs = (totalSecs % 60).toString().padStart(2, '0');
    const tenths = Math.floor((ms % 1000) / 100);
    return `${mins}:${secs}.${tenths}`;
  };


  // 基于第一性原理的动态认知状态映射（替代虚假的固定秒数打勾流水线）
  const getNarrativeText = (ms: number, queued: boolean, paused: boolean, hasCheckpointProgress: boolean) => {
    if (paused) return m.uninitialized_chapter_paused();
    if (queued) return m.uninitialized_chapter_narrative_queued();
    // 物理断点事实优先：已有存档分块表明已进入深度编撰/校准阶段，杜绝退回粗读阶段
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

  return (
    <div className="flex flex-col items-center justify-center p-8 max-w-xl mx-auto my-8 relative rounded-3xl border border-theme-border bg-theme-bg shadow-sm transition-all select-none">
      <div className="absolute inset-0 bg-gradient-to-b from-amber-500/5 via-transparent to-transparent pointer-events-none rounded-3xl" />


      {loadError ? (
        <div className="relative z-10 flex flex-col items-center gap-4 text-center py-6">
          <div className="p-3.5 rounded-full bg-theme-accent/10 text-theme-accent">
            <AlertTriangle size={32} />
          </div>

          <h2 className="text-lg font-bold text-theme-foreground">
            {m.uninitialized_chapter_abnormal()}
          </h2>

          <p className="text-sm text-theme-muted max-w-sm">
            {loadError}
          </p>

          {hasCheckpoints && job?.totalChunks ? (
            <p className="text-caption font-mono text-theme-primary font-semibold">
              {m.uninitialized_chapter_checkpoint_progress({ saved: job.savedChunks, total: job.totalChunks })}
            </p>
          ) : null}

          <div className="flex flex-col sm:flex-row gap-3 mt-4">
            {hasCheckpoints && (
              <button
                type="button"
                disabled={resumeBusy}
                onClick={handleResumeFromCheckpoint}
                className="px-4 py-2 text-xs font-semibold rounded-xl bg-theme-primary hover:opacity-90 text-theme-primary-fg transition-opacity cursor-pointer flex items-center justify-center gap-1.5 shadow-xs disabled:opacity-60"
              >
                <Play size={14} />
                {m.uninitialized_chapter_resume_transcription()}
              </button>
            )}

            <button
              type="button"
              onClick={() => {
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
                  }
                });
              }}
              className="px-4 py-2 text-xs font-semibold rounded-xl bg-theme-primary hover:opacity-90 text-theme-primary-fg transition-opacity cursor-pointer flex items-center justify-center gap-1.5 shadow-xs"
            >
              <RefreshCw size={14} />
              {m.uninitialized_chapter_retry_init()}
            </button>

          </div>
        </div>
      ) : (
        <div className="relative z-10 w-full flex flex-col items-center text-center max-w-sm mx-auto">
          
          {/* 1. Giant Center Play/Pause Hero Button */}
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

          {/* 2. Minimalist Title & Meta */}
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

          {/* 3. Real Progress & Cognitive Narrative Panel (Unified Surface - 方案 A) */}
          <div className="relative w-full px-2 flex flex-col items-center gap-3">
            <div className="w-full bg-theme-surface/70 border border-theme-border/60 rounded-2xl p-4 flex flex-col gap-3 shadow-2xs transition-all duration-300">
              {/* Header Row: Left is Live Status (Icon + Text), Right is Quantitative Progress (Ratio/Percentage) */}
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

              {/* Unified Single Progress Bar */}
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

            {/* 真实物理心跳超时自愈提示（仅在系统确凿检测到上游超时无响应且非排队未暂停时显示） */}
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

          {/* 常驻辅助逃生入口（温和低调文本按钮） */}
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
