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
  /** 当前正在并发处理中的文档 ID 集合 */
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
  /** 插队指定文档；resolve 值为服务端是否接受（false=被拒/虚拟章守卫拦截，本地已回滚） */
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
  /**
   * 实时更新通道 gating（性能修复 2026-10-13）：true（维护者/个人批量模式）维持
   * 10s 轮询 + SSE；false（普通读者/匿名公开仓）断开 SSE 常驻连接，轮询自适应——
   * 存在非终态文档（转录中/待转录）时 10s，全部稳定后退避 60s 心跳（保住接力
   * 新任务出现与未转录章节 JIT 翻转的最终可见性）。初始 refreshStatus 不受
   * gating 影响（侧栏徽章首绘依赖）。
   */
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


  // 插队章节就绪后主动刷新页面路由
  const prevPrioritizedRef = useRef<string | null>(null);
  useEffect(() => {
    if (prioritizedId) {
      prevPrioritizedRef.current = prioritizedId;
    } else if (prevPrioritizedRef.current) {
      prevPrioritizedRef.current = null;
      router.refresh();
    }
  }, [prioritizedId, router]);

  // 当可用讲法（edition）列表数量或条目发生变更时（例如从公共广场收藏了新讲法、或后台转录完成新讲法），
  // 自动触发 router.refresh() 无缝热更新服务端布局，让侧边栏立即呈现多版本切换器与导航树
  const prevEditionsFingerprintRef = useRef<string>('');
  useEffect(() => {
    if (!availableEditions || availableEditions.length === 0) return;
    const currentFingerprint = availableEditions.map((e) => e.id).sort().join(',');
    if (prevEditionsFingerprintRef.current && prevEditionsFingerprintRef.current !== currentFingerprint) {
      router.refresh();
    }
    prevEditionsFingerprintRef.current = currentFingerprint;
  }, [availableEditions, router]);

  // Page hide automatic pause handler
  // 【受控例外 #2 · 读路径显式写】仅当用户显式开启 INGEST_PAUSE_ON_CLOSE 本地开关才触发；
  // 登记于 lib/state/README.md §四——新增读路径写必须先登记
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

  // Periodic status poll
  // 周期性同步服务端转录状态：其他标签页/会话的队列或 JIT 可能已推进状态，
  // UI 需定期拉取才能反映最新进度（PROCESSED / ERROR / PROCESSING 状态翻转）。
  // liveUpdates=false 时自适应退避：存在非终态文档 10s（活动转录/JIT 等待），
  // 全部稳定后退避 60s 心跳；页面隐藏期间暂停轮询。
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

  // 转录状态 SSE（Phase 3 #9）：worker 侧任务状态/存档计数变化即触发拉取，
  // 准实时于 10s 轮询；EventSource 断线自动重连，连续失败熔断后轮询保留为兜底通道。
  // liveUpdates=false 不建连：普通读者/匿名公开仓不需要常驻长连接（事件只是
  // refresh 触发器，自适应轮询已覆盖其可见性需求）
  useEffect(() => {
    if (!owner || !repo || !liveUpdates) return;
    // 等待 IngestQueueEditionSync 将 URL 的 ?edition= 同步进 store 后再建连，
    // 避免首帧以默认空 edition 发起请求后又立刻 abort 产生 (canceled)。
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
        // 连续 3 次失败（如 404 仓未导入或服务端不可达），主动切断 EventSource 避免浏览器无限重试风暴
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

  // 总体进度走 memoized 纯投影选择器（计数单一编码源：课程投影器），
  // 取代原先的内联 documents.filter——与胶囊/侧栏口径严格一致且引用恒定
  const ingestProgress = useIngestProgress();

  const hasAutoSubmittedRef = useRef(false);
  // 【受控例外 #1 · 延期发布意图】用户导入时勾选的公开意图的延期执行（登记于 lib/state/README.md §四）
  useEffect(() => {
    // 发布意图单一仲裁点：自动触发条件只在 projectPublishIntent 中编码一处
    // （与服务端 ingest-status 闭环自愈共用同一纯函数）
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

/**
 * 细粒度 Hooks 与单槽记忆选择器：按需消费对应切片，严格保证引用恒定 (Object.is === true)，彻底杜绝 React 19 循环重渲染
 */

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

/** 仅订阅转录总体进度（已处理数 / 总篇章数） */
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
  /** 插队指定文档；resolve 值为服务端是否接受（false=被拒/虚拟章守卫拦截，本地已回滚） */
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
