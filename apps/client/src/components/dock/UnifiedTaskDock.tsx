'use client';

/**
 * 统一全局后台任务托盘 (Unified Task Dock · 方案 A)
 *
 * 将系统散落的多个浮动胶囊统一收拢至右下角单个锚点：
 * 1. 向导编排/入库最小化 (Import Wizard Draft)
 * 2. 教程章节转录详情 (Tutorial Chapter Transcriptions · 原顶部悬浮胶囊)
 * 3. 阅读器当前教程转录队列 (Current Reader Ingest)
 * 4. 接力转录任务 (Relay Task)
 *
 * 单任务时精简直观；多任务时智能聚合，向上浮出 (Dropup) 详情卡片面板。
 * 彻底消除顶部视口遮挡与多任务重叠冲突。
 */

import React, { useEffect, useState, useRef, useMemo, useCallback, Suspense } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import {
  Loader2,
  CheckCircle2,
  Clock,
  AlertTriangle,
  ChevronUp,
  X,
  BookOpen,
  Zap,
  Sparkles,
  Pause,
  Play,
} from 'lucide-react';

import * as m from '@/paraglide/messages';
import { docPathToSlug } from '@/lib/outline-reader';
import { normalizeDocPath } from '@/lib/doc-path';
import { STORAGE_KEYS } from '@/lib/constants';
import { safeGetJSON, safeRemove } from '@/lib/storage-utils';

import {
  useTutorialDockStore,
  type MinimizedTutorial,
} from '@/lib/stores/transcription-dock-store';
import { syncDockTutorialFromFacts, seedDockTutorial } from '@/lib/stores/dock-sync';
import { projectDockTutorialFacts } from '@/lib/state/dock-status-projector';
import type { ChapterDocumentInput } from '@/lib/state/curriculum-lifecycle-contract';

import {
  useImportWizardStore,
  wizardSetters,
  getWizardLifecycleState,
  getWizardCapsuleState,
  SAVED_JOB_LOADING_CAPSULE,
  type WizardCapsuleState,
  type WizardCapsuleStatusKind,
} from '@/lib/stores/import-wizard-store';

import { useRelayTaskStore } from '@/lib/stores/relay-task-store';
import { useIngestQueueStore, matchDocPath } from '@/lib/stores/ingest-queue-store';
import { projectCourseLifecycleState } from '@/lib/state/curriculum-state-projector';
import { parseChapterTitle } from '@/lib/chapter-title';

const JOB_POLL_INTERVAL_MS = 5000;

interface SavedJob {
  jobId: string;
  owner: string;
  repo: string;
}

function resolveChapterTitle(doc: { title?: string | null; path: string } | null): string {
  if (!doc) return '';
  if (doc.title) {
    const parsed = parseChapterTitle(doc.title);
    return parsed.cleanTitle || doc.title;
  }
  const filename = doc.path.split('/').pop() || doc.path;
  const cleanFilename = filename.replace(/\.(md|mdx|markdown)$/i, '');
  const parsed = parseChapterTitle(cleanFilename);
  return parsed.cleanTitle || cleanFilename;
}

function isDockTutorialPending(tut: MinimizedTutorial): boolean {
  return (
    tut.status === 'PROCESSING' ||
    tut.status === 'QUEUED' ||
    tut.totalChapters === 0 ||
    tut.completedChapters < tut.totalChapters
  );
}

function WizardStatusIcon({ kind }: { kind: WizardCapsuleStatusKind }) {
  switch (kind) {
    case 'loading':
      return (
        <span className="relative flex items-center justify-center w-6 h-6 rounded-full bg-theme-primary/10 border border-theme-primary/30 shrink-0">
          <Loader2 className="w-3.5 h-3.5 text-theme-primary animate-spin" />
        </span>
      );
    case 'action_required':
      return (
        <span className="relative flex items-center justify-center w-6 h-6 rounded-full bg-amber-500/15 border border-amber-500/30 shrink-0">
          <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500 animate-pulse" />
        </span>
      );
    case 'success':
      return (
        <span className="relative flex items-center justify-center w-6 h-6 rounded-full bg-emerald-500/15 border border-emerald-500/30 shrink-0">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
        </span>
      );
    case 'error':
      return (
        <span className="relative flex items-center justify-center w-6 h-6 rounded-full bg-rose-500/15 border border-rose-500/30 shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />
        </span>
      );
  }
}

function WizardStatusBadge({
  kind,
  label,
}: {
  kind: WizardCapsuleStatusKind;
  label: string;
}) {
  const colorMap: Record<WizardCapsuleStatusKind, string> = {
    loading: 'bg-theme-primary/10 text-theme-primary border-theme-primary/25',
    action_required: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
    success: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
    error: 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30',
  };

  return (
    <span
      className={`px-1.5 py-0.2 rounded-full text-micro font-medium border shrink-0 ${colorMap[kind]}`}
    >
      {label}
    </span>
  );
}

function UnifiedTaskDockInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const dockRef = useRef<HTMLDivElement>(null);

  const [isOpen, setIsOpen] = useState(false);

  // ----------------------------------------------------
  // 1. 向导导入任务 (Import Wizard)
  // ----------------------------------------------------
  const wizardOpen = useImportWizardStore((s) => s.isOpen);
  const wizardCollapsed = useImportWizardStore((s) => s.isCollapsed);
  const wizardIngestSuccessInfo = useImportWizardStore((s) => s.ingestSuccessInfo);
  const wizardLogs = useImportWizardStore((s) => s.logs);
  const wizardScoutOwner = useImportWizardStore((s) => s.scoutData?.owner);
  const wizardScoutRepo = useImportWizardStore((s) => s.scoutData?.repo);
  const wizardStep = useImportWizardStore((s) => s.step);
  const wizardCustomOutline = useImportWizardStore((s) => s.customOutline);
  const wizardDraftLoading = useImportWizardStore((s) => s.draftLoading);
  const wizardUrl = useImportWizardStore((s) => s.url);

  const wizardLifecycle = useImportWizardStore(getWizardLifecycleState);
  const homeWizardRunning =
    wizardLifecycle === 'SUBMITTING' ||
    (wizardLifecycle === 'HANDOFF' && !wizardIngestSuccessInfo);

  const [savedJob, setSavedJob] = useState<SavedJob | null>(null);
  const [savedJobRunning, setSavedJobRunning] = useState(false);

  const isHome = pathname === '/';
  const dialogVisible = wizardOpen && !wizardCollapsed;
  const wizardRunning = homeWizardRunning || savedJobRunning;
  const isImportActive = !dialogVisible && (wizardCollapsed ? wizardOpen : wizardRunning);

  const wizardCapsuleFromStore = useImportWizardStore(getWizardCapsuleState);
  const activeWizardCapsule: WizardCapsuleState = useMemo(() => {
    if (wizardOpen) {
      return wizardCapsuleFromStore;
    }
    if (savedJobRunning) {
      return SAVED_JOB_LOADING_CAPSULE;
    }
    return wizardCapsuleFromStore;
  }, [wizardOpen, wizardCapsuleFromStore, savedJobRunning]);

  // 离开首页后轮询导入落盘快照
  useEffect(() => {
    if (isHome) return;
    let cancelled = false;
    const tick = async () => {
      const saved = safeGetJSON<SavedJob | null>(STORAGE_KEYS.LAST_IMPORT_JOB, null);
      if (!saved?.jobId) {
        if (!cancelled) {
          setSavedJob(null);
          setSavedJobRunning(false);
        }
        return;
      }
      try {
        const res = await fetch(`/api/ingest-jobs/${saved.jobId}?since=-1`, { cache: 'no-store' });
        if (!res.ok) {
          safeRemove(STORAGE_KEYS.LAST_IMPORT_JOB);
          if (!cancelled) {
            setSavedJob(null);
            setSavedJobRunning(false);
          }
          return;
        }
        const snapshot = await res.json();
        const status: string | undefined = snapshot?.job?.status;
        const live = status === 'QUEUED' || status === 'RUNNING';
        if (!live) safeRemove(STORAGE_KEYS.LAST_IMPORT_JOB);
        if (!cancelled) {
          setSavedJob(saved);
          setSavedJobRunning(live);
        }
      } catch {
        // 网络抖动容错
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), JOB_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isHome]);

  const webDocHostname = (() => {
    try {
      return new URL(wizardUrl).hostname;
    } catch {
      return '';
    }
  })();
  const wizardCurrentRepoLabel =
    wizardScoutOwner && wizardScoutRepo
      ? `${wizardScoutOwner}/${wizardScoutRepo}`
      : webDocHostname || '';
  const wizardRepoLabel = wizardCurrentRepoLabel || (savedJob ? `${savedJob.owner}/${savedJob.repo}` : '');

  const restoreSuffix = m.import_capsule_hint().split('·')[1]?.trim() || m.common_back();
  const latestLog = wizardLogs.length > 0 ? wizardLogs[wizardLogs.length - 1] : '';
  const wizardSubtitle =
    wizardStep === 2
      ? wizardDraftLoading || wizardCustomOutline.length === 0
        ? `${m.import_wizard_generating_outline()} · ${restoreSuffix}`
        : `${m.import_wizard_step_orchestrate()} · ${restoreSuffix}`
      : latestLog
      ? latestLog.slice(0, 50)
      : m.import_capsule_hint();

  const handleRestoreWizard = () => {
    wizardSetters.expandWizard();
    setIsOpen(false);
  };

  // ----------------------------------------------------
  // 2. 接力转录任务 (Relay Task)
  // ----------------------------------------------------
  const relayActiveTask = useRelayTaskStore((s) => s.activeTask);
  const relayWorkbenchOpen = useRelayTaskStore((s) => s.isWorkbenchOpen);
  const setRelayWorkbenchOpen = useRelayTaskStore((s) => s.setWorkbenchOpen);
  const dismissRelayTask = useRelayTaskStore((s) => s.dismissTask);
  const isRelayActive = Boolean(relayActiveTask && !relayWorkbenchOpen);

  const [relayElapsed, setRelayElapsed] = useState(0);
  useEffect(() => {
    if (!relayActiveTask || relayActiveTask.status !== 'running') return;
    const compute = () => {
      const diff = Math.max(0, Math.floor((Date.now() - relayActiveTask.startedAt) / 1000));
      setRelayElapsed(diff);
    };
    compute();
    const t = setInterval(compute, 1000);
    return () => clearInterval(t);
  }, [relayActiveTask]);

  const handleOpenRelay = () => {
    setRelayWorkbenchOpen(true);
    setIsOpen(false);
  };

  // ----------------------------------------------------
  // 3. 当前阅读视口教程转录 (Current Reader Ingest)
  // ----------------------------------------------------
  const isDocsPage = Boolean(pathname?.startsWith('/docs/'));
  const currentDocMatch = pathname?.match(/^\/docs\/([^/]+)\/([^/]+)/);
  const currentDocOwner = currentDocMatch?.[1];
  const currentDocRepo = currentDocMatch?.[2];
  const currentDocEdition = searchParams?.get('edition') ?? '';

  const queueDocs = useIngestQueueStore((s) => s.documents);
  const queueIsPaused = useIngestQueueStore((s) => s.isPaused);
  const queueCurrentProcessingId = useIngestQueueStore((s) => s.currentProcessingId);
  const queueProcessingDocIds = useIngestQueueStore((s) => s.processingDocIds);
  const queueOwner = useIngestQueueStore((s) => s.owner);
  const queueRepo = useIngestQueueStore((s) => s.repo);
  const queuePause = useIngestQueueStore((s) => s.pause);
  const queueResume = useIngestQueueStore((s) => s.resume);

  const isCurrentDocQueueMatch = Boolean(
    isDocsPage &&
      currentDocOwner &&
      currentDocRepo &&
      queueOwner === currentDocOwner &&
      queueRepo === currentDocRepo &&
      queueDocs.length > 0
  );

  const currentCourseLifecycle = useMemo(() => {
    if (!isCurrentDocQueueMatch) return null;
    return projectCourseLifecycleState(queueDocs, queueIsPaused, {
      currentProcessingId: queueCurrentProcessingId,
      processingDocIds: queueProcessingDocIds,
    });
  }, [isCurrentDocQueueMatch, queueDocs, queueIsPaused, queueCurrentProcessingId, queueProcessingDocIds]);

  const isCurrentDocIngestActive = Boolean(
    isCurrentDocQueueMatch &&
      currentCourseLifecycle &&
      currentCourseLifecycle.total > 0 &&
      !currentCourseLifecycle.isCompleted
  );

  const currentActiveDoc = useMemo(() => {
    if (!isCurrentDocIngestActive) return null;
    return (
      queueDocs.find(
        (d) =>
          d.id === queueCurrentProcessingId || queueProcessingDocIds.includes(d.id) || d.status === 'PROCESSING'
      ) ?? null
    );
  }, [isCurrentDocIngestActive, queueDocs, queueCurrentProcessingId, queueProcessingDocIds]);

  const currentActiveTitle = resolveChapterTitle(currentActiveDoc);

  // 当读者在教程阅读视口内时，将实时的转录进展同步回全局 Dock Store（消除内外两重视角信息差）
  useEffect(() => {
    if (!isCurrentDocQueueMatch || queueDocs.length === 0 || !currentDocOwner || !currentDocRepo) return;
    const facts = projectDockTutorialFacts(queueDocs);
    const dockId = currentDocEdition
      ? `${currentDocOwner}/${currentDocRepo}:${currentDocEdition}`
      : `${currentDocOwner}/${currentDocRepo}`;

    const existing = useTutorialDockStore.getState().getTutorial(dockId);
    const editionQuery = currentDocEdition ? `?edition=${encodeURIComponent(currentDocEdition)}` : '';
    let targetUrl = `${pathname}${editionQuery}`;
    if (facts.dockStatus !== 'PROCESSED' && facts.activeDocPath) {
      const cleanPath = docPathToSlug(normalizeDocPath(facts.activeDocPath));
      targetUrl = `/docs/${currentDocOwner}/${currentDocRepo}/${cleanPath}${editionQuery}`;
    }

    if (existing) {
      syncDockTutorialFromFacts(existing, facts, targetUrl);
    } else {
      seedDockTutorial({
        id: dockId,
        owner: currentDocOwner,
        repo: currentDocRepo,
        edition: currentDocEdition || null,
        title: currentDocRepo,
        url: targetUrl,
        status: facts.dockStatus,
        startedAt: Date.now(),
        completedChapters: facts.completedChapters,
        totalChapters: facts.totalChapters,
        updatedAt: Date.now(),
        activeChapterTitle: facts.activeChapterTitle,
        activeDocPath: facts.activeDocPath,
      });
    }
  }, [isCurrentDocQueueMatch, queueDocs, currentDocOwner, currentDocRepo, currentDocEdition, pathname]);

  // ----------------------------------------------------
  // 4. 后台全局教程转录 (Tutorial Dock Store)
  // ----------------------------------------------------
  const dockTutorials = useTutorialDockStore((s) => s.tutorials);
  const removeDockTutorial = useTutorialDockStore((s) => s.removeTutorial);
  const clearCompletedDockTutorials = useTutorialDockStore((s) => s.clearCompleted);

  // 订阅是否存在未完结的后台教程（仅当存在时才开启后台状态同步定时器，避免全局空转）
  const hasPendingBackgroundTutorials = useTutorialDockStore(
    useCallback(
      (s) =>
        s.tutorials.some((tut) => {
          if (!isDockTutorialPending(tut)) return false;
          if (isDocsPage && currentDocOwner && currentDocRepo) {
            if (tut.owner === currentDocOwner && tut.repo === currentDocRepo) {
              const tutEdition = tut.edition || '';
              if (tutEdition === (currentDocEdition || '')) return false;
            }
          }
          return true;
        }),
      [isDocsPage, currentDocOwner, currentDocRepo, currentDocEdition]
    )
  );

  // 过滤：若读者当前已处于某个教程阅读视口内，该教程不在后台列表中重复列出
  const backgroundTutorials = useMemo(() => {
    return dockTutorials.filter((tut) => {
      if (isDocsPage && currentDocOwner && currentDocRepo) {
        if (tut.owner === currentDocOwner && tut.repo === currentDocRepo) {
          const tutEdition = tut.edition || '';
          if (tutEdition === currentDocEdition) return false;
        }
      }
      return true;
    });
  }, [dockTutorials, isDocsPage, currentDocOwner, currentDocRepo, currentDocEdition]);

  // 自动出栈 1：当读者进入已转录完成 (PROCESSED) 的教程视口，完成提示目标达成，从全局 Dock 自动移除
  useEffect(() => {
    if (!isDocsPage || !currentDocOwner || !currentDocRepo) return;
    const matchingCompleted = dockTutorials.find(
      (tut) =>
        tut.owner === currentDocOwner &&
        tut.repo === currentDocRepo &&
        (tut.edition || '') === currentDocEdition &&
        tut.status === 'PROCESSED'
    );
    if (matchingCompleted) {
      removeDockTutorial(matchingCompleted.id);
    }
  }, [isDocsPage, currentDocOwner, currentDocRepo, currentDocEdition, dockTutorials, removeDockTutorial]);

  // 自动出栈 2：超过 12 小时的历史已就绪任务自动归档清理，避免 localStorage 积攒无用历史记录
  useEffect(() => {
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;
    const now = Date.now();
    dockTutorials.forEach((tut) => {
      if (tut.status === 'PROCESSED' && now - (tut.updatedAt || tut.startedAt) > TWELVE_HOURS) {
        removeDockTutorial(tut.id);
      }
    });
  }, [dockTutorials, removeDockTutorial]);

  // 后台轮询服务端文档转录事实（自愈性全覆盖：仅对后台未完结教程按 5s 周期进行轻量心跳同步）
  useEffect(() => {
    if (!hasPendingBackgroundTutorials) return;

    let cancelled = false;
    let isPolling = false;

    const poll = async () => {
      if (cancelled || isPolling || document.visibilityState !== 'visible') return;
      isPolling = true;

      try {
        const tutorials = useTutorialDockStore.getState().tutorials;
        const activeTuts = tutorials.filter((tut) => {
          if (!isDockTutorialPending(tut)) return false;
          if (isDocsPage && currentDocOwner && currentDocRepo) {
            if (tut.owner === currentDocOwner && tut.repo === currentDocRepo) {
              const tutEdition = tut.edition || '';
              if (tutEdition === (currentDocEdition || '')) return false;
            }
          }
          return true;
        });

        if (activeTuts.length === 0) return;

        for (const tut of activeTuts) {
          if (cancelled) return;
          try {
            const editionQuery = tut.edition ? `?edition=${encodeURIComponent(tut.edition)}` : '';
            const res = await fetch(`/api/ingest-status/${encodeURIComponent(tut.owner)}/${encodeURIComponent(tut.repo)}${editionQuery}`, {
              cache: 'no-store',
              credentials: 'same-origin',
            });
            if (!res.ok) continue;
            const json = await res.json();
            const data = json?.data || json;
            const rawDocs = (data?.documents ?? []) as ChapterDocumentInput[];
            if (rawDocs.length > 0) {
              const facts = projectDockTutorialFacts(rawDocs);
              if (cancelled) return;
              let targetUrl = tut.url;
              if (facts.dockStatus !== 'PROCESSED' && facts.activeDocPath) {
                const cleanPath = docPathToSlug(normalizeDocPath(facts.activeDocPath));
                targetUrl = `/docs/${tut.owner}/${tut.repo}/${cleanPath}${editionQuery}`;
              }
              syncDockTutorialFromFacts(tut, facts, targetUrl);
            }
          } catch {
            // 容错轮询
          }
        }
      } finally {
        isPolling = false;
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [hasPendingBackgroundTutorials, isDocsPage, currentDocOwner, currentDocRepo, currentDocEdition]);

  const handleSelectTutorial = (tutorial: MinimizedTutorial) => {
    // 点击进入阅读时，已就绪教程立即从全局 Dock 移除
    if (tutorial.status === 'PROCESSED') {
      removeDockTutorial(tutorial.id);
    }
    let targetUrl = tutorial.url || `/docs/${tutorial.owner}/${tutorial.repo}`;
    if (tutorial.edition) {
      try {
        const parsed = new URL(targetUrl, 'http://localhost');
        if (!parsed.searchParams.has('edition')) {
          parsed.searchParams.set('edition', tutorial.edition);
          targetUrl = `${parsed.pathname}${parsed.search}`;
        }
      } catch {
        if (!targetUrl.includes('edition=')) {
          targetUrl += `${targetUrl.includes('?') ? '&' : '?'}edition=${encodeURIComponent(tutorial.edition)}`;
        }
      }
    }
    router.push(targetUrl);
    setIsOpen(false);
  };

  // 点击外部收起向上浮出面板
  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (dockRef.current && !dockRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // ----------------------------------------------------
  // 5. 聚合度量与展示决策
  // ----------------------------------------------------
  const runningBackgroundTutorials = useMemo(
    () => backgroundTutorials.filter((t) => t.status === 'PROCESSING' || t.status === 'QUEUED'),
    [backgroundTutorials]
  );
  const completedBackgroundTutorials = useMemo(
    () => backgroundTutorials.filter((t) => t.status === 'PROCESSED'),
    [backgroundTutorials]
  );
  const errorBackgroundTutorials = useMemo(
    () => backgroundTutorials.filter((t) => t.status === 'ERROR'),
    [backgroundTutorials]
  );

  const runningTaskCount =
    (isImportActive ? 1 : 0) +
    (isRelayActive ? 1 : 0) +
    (isCurrentDocIngestActive ? 1 : 0) +
    runningBackgroundTutorials.length;

  const totalDockCount =
    (isImportActive ? 1 : 0) +
    (isRelayActive ? 1 : 0) +
    (isCurrentDocIngestActive ? 1 : 0) +
    backgroundTutorials.length;

  // 全站没有任何活跃或需呈现的后台任务：彻底隐身
  if (totalDockCount === 0) {
    return null;
  }

  // 单任务判定：如果仅有向导草稿，直接单触点恢复
  const isOnlyImport = totalDockCount === 1 && isImportActive;

  return (
    <div
      ref={dockRef}
      className="fixed bottom-6 right-6 z-[95] text-left select-none max-w-[min(480px,92vw)] font-sans"
    >
      {/* 🌟 向上浮出详情卡片面板 (Dropup Panel) */}
      {isOpen && (
        <div className="absolute bottom-full mb-3 right-0 w-[94vw] sm:w-[420px] max-w-[440px] max-h-[min(540px,75vh)] bg-theme-bg/95 border border-theme-border rounded-2xl shadow-2xl backdrop-blur-xl flex flex-col overflow-hidden text-left z-[1000] animate-in fade-in slide-in-from-bottom-2 duration-200">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-theme-border/60 bg-theme-surface/40">
            <div className="flex items-center gap-2">
              <BookOpen size={15} className="text-theme-primary" />
              <span className="font-bold text-xs text-theme-foreground">
                {m.tutorial_dock_title()}
              </span>
              <span className="px-2 py-0.5 rounded-full text-micro font-mono font-semibold bg-theme-surface border border-theme-border/60 text-theme-muted">
                {totalDockCount}
              </span>
            </div>

            <div className="flex items-center gap-2">
              {backgroundTutorials.some((t) => t.status === 'PROCESSED') && (
                <button
                  type="button"
                  onClick={clearCompletedDockTutorials}
                  className="text-caption text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer"
                >
                  {m.transcription_dock_clear_completed()}
                </button>
              )}
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="p-1 rounded-lg text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/80 transition-all cursor-pointer"
                aria-label={m.common_close()}
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {/* Body: 统一任务分区列表 */}
          <div className="overflow-y-auto p-3.5 space-y-2.5 max-h-[460px] custom-scrollbar">
            {/* 1. 向导导入任务草稿 */}
            {isImportActive && (
              <div className="p-3 rounded-xl border border-theme-border/70 bg-theme-surface/40 hover:bg-theme-surface/70 transition-all flex flex-col gap-2 shadow-2xs">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2.5 min-w-0 flex-1">
                    <WizardStatusIcon kind={activeWizardCapsule.statusKind} />
                    <div className="flex flex-col min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-xs font-bold font-mono text-theme-foreground truncate">
                          {wizardRepoLabel}
                        </span>
                        <WizardStatusBadge
                          kind={activeWizardCapsule.statusKind}
                          label={activeWizardCapsule.badgeLabel}
                        />
                      </div>
                      <span className="text-caption text-theme-muted truncate mt-0.5">
                        {activeWizardCapsule.detailText}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-end pt-1 border-t border-theme-border/40">
                  <button
                    type="button"
                    onClick={handleRestoreWizard}
                    className="px-3 py-1 bg-theme-primary text-theme-primary-fg text-micro font-bold rounded-lg hover:opacity-90 transition-all shadow-2xs cursor-pointer"
                  >
                    {activeWizardCapsule.statusKind === 'action_required'
                      ? activeWizardCapsule.actionHint
                      : m.tutorial_dock_reenter()}
                  </button>
                </div>
              </div>
            )}

            {/* 2. 当前阅读视口教程转录 */}
            {isCurrentDocIngestActive && currentCourseLifecycle && (
              <div className="p-3 rounded-xl border border-theme-primary/30 bg-theme-primary/5 transition-all flex flex-col gap-2 shadow-2xs">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2.5 min-w-0 flex-1">
                    <span className="mt-0.5 flex items-center justify-center w-5 h-5 rounded-full bg-theme-primary/15 border border-theme-primary/30 text-theme-primary shrink-0">
                      <Zap size={12} className="fill-current" />
                    </span>
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-xs font-bold font-mono text-theme-foreground truncate">
                        {currentDocOwner}/{currentDocRepo}
                      </span>
                      <span className="text-caption text-theme-muted truncate mt-0.5">
                        {currentActiveTitle ? `⚡ ${currentActiveTitle}` : m.status_processing()}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      if (queueIsPaused) queueResume();
                      else queuePause();
                    }}
                    className="p-1 rounded-md text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-colors cursor-pointer shrink-0"
                    title={queueIsPaused ? m.ingest_action_resume() : m.ingest_action_pause()}
                  >
                    {queueIsPaused ? <Play size={13} /> : <Pause size={13} />}
                  </button>
                </div>

                {/* 实时进度条 */}
                <div className="flex flex-col gap-1 pl-7">
                  <div className="flex items-center justify-between text-micro font-mono text-theme-muted">
                    <span>
                      {m.tutorial_dock_progress({
                        completed: currentCourseLifecycle.processed,
                        total: currentCourseLifecycle.total,
                      })}
                    </span>
                    <span>{currentCourseLifecycle.progressPct}%</span>
                  </div>
                  <div className="w-full h-1.5 bg-theme-border/50 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-theme-primary transition-all duration-300 rounded-full"
                      style={{ width: `${currentCourseLifecycle.progressPct}%` }}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* 3. 后台教程列表 */}
            {backgroundTutorials.map((tut) => {
              const isTutDone = tut.status === 'PROCESSED';
              const isTutQueued = tut.status === 'QUEUED';
              const isTutError = tut.status === 'ERROR';
              const progressPct =
                tut.totalChapters > 0
                  ? Math.round((tut.completedChapters / tut.totalChapters) * 100)
                  : 0;

              return (
                <div
                  key={tut.id}
                  onClick={() => handleSelectTutorial(tut)}
                  className="group relative p-3 rounded-xl border border-theme-border/60 bg-theme-surface/50 hover:bg-theme-surface hover:border-theme-primary/40 transition-all cursor-pointer flex flex-col gap-2 shadow-2xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      <div className="mt-0.5 shrink-0">
                        {isTutDone ? (
                          <CheckCircle2 size={16} className="text-emerald-600 dark:text-emerald-400 stroke-[2.5px]" />
                        ) : isTutQueued ? (
                          <Clock size={16} className="text-theme-muted" />
                        ) : isTutError ? (
                          <AlertTriangle size={16} className="text-theme-accent" />
                        ) : (
                          <Loader2 size={16} className="animate-spin text-theme-primary" />
                        )}
                      </div>

                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-xs font-bold text-theme-foreground truncate group-hover:text-theme-primary transition-colors">
                          {tut.title}
                        </span>
                        <div className="flex items-center gap-1.5 text-caption font-mono text-theme-muted truncate mt-0.5">
                          <span>
                            {tut.owner}/{tut.repo}
                          </span>
                          {tut.edition && (
                            <span className="px-1.5 py-0.2 rounded text-micro font-sans font-medium bg-theme-surface border border-theme-border/60 text-theme-muted shrink-0">
                              {tut.edition}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeDockTutorial(tut.id);
                      }}
                      className="p-1 rounded-lg text-theme-muted hover:text-theme-foreground hover:bg-theme-bg/80 opacity-60 group-hover:opacity-100 transition-all shrink-0 cursor-pointer"
                      title={m.transcription_dock_dismiss()}
                    >
                      <X size={13} />
                    </button>
                  </div>

                  <div className="flex flex-col gap-1.5 pl-6 text-caption">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-theme-muted truncate">
                        {isTutDone
                          ? m.tutorial_dock_all_done()
                          : tut.activeChapterTitle
                          ? `⚡ ${tut.activeChapterTitle}`
                          : m.status_processing()}
                      </span>
                      <span className="font-semibold text-caption shrink-0 transition-transform group-hover:translate-x-0.5 text-theme-primary flex items-center gap-0.5">
                        {isTutDone ? m.tutorial_dock_read_now() : m.tutorial_dock_reenter()}
                        <span>→</span>
                      </span>
                    </div>

                    {tut.totalChapters > 0 && (
                      <div className="flex flex-col gap-1 mt-0.5">
                        <div className="flex items-center justify-between text-micro font-mono text-theme-muted">
                          <span>
                            {m.tutorial_dock_progress({
                              completed: tut.completedChapters,
                              total: tut.totalChapters,
                            })}
                          </span>
                          <span>{progressPct}%</span>
                        </div>
                        <div className="w-full h-1.5 bg-theme-border/40 rounded-full overflow-hidden">
                          <div
                            className={`h-full transition-all duration-300 rounded-full ${
                              isTutDone ? 'bg-emerald-600' : 'bg-theme-primary'
                            }`}
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* 4. 接力转录任务 */}
            {isRelayActive && relayActiveTask && (
              <div
                onClick={handleOpenRelay}
                className="group p-3 rounded-xl border border-theme-border/70 bg-theme-surface/50 hover:bg-theme-surface transition-all cursor-pointer flex flex-col gap-2 shadow-2xs"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2.5 min-w-0 flex-1">
                    <span className="mt-0.5 flex items-center justify-center w-5 h-5 rounded-full bg-theme-primary/10 border border-theme-primary/30 shrink-0">
                      <Sparkles className="w-3 h-3 text-theme-primary animate-pulse" />
                    </span>
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-xs font-bold text-theme-foreground truncate group-hover:text-theme-primary transition-colors">
                        {relayActiveTask.title}
                      </span>
                      <span className="text-caption text-theme-muted truncate mt-0.5">
                        {relayActiveTask.status === 'running'
                          ? m.dock_relay_running({ seconds: relayElapsed })
                          : relayActiveTask.status === 'completed'
                          ? m.dock_transcribe_completed()
                          : m.dock_transcribe_failed()}
                      </span>
                    </div>
                  </div>

                  {dismissRelayTask && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        dismissRelayTask();
                      }}
                      className="p-1 rounded-lg text-theme-muted hover:text-theme-foreground transition-all shrink-0 cursor-pointer"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 🌟 底部常驻悬浮胶囊按钮 (Collapsed Capsule Pill) */}
      <button
        type="button"
        onClick={() => {
          if (isOnlyImport) {
            handleRestoreWizard();
          } else {
            setIsOpen((prev) => !prev);
          }
        }}
        aria-label={m.tutorial_dock_title()}
        className="group flex items-center gap-2.5 pl-3 pr-4 py-2 rounded-full bg-theme-bg/95 border border-theme-border shadow-lg hover:border-theme-primary/60 hover:shadow-xl transition-all cursor-pointer max-w-full backdrop-blur-md select-none text-theme-foreground ring-1 ring-black/5 dark:ring-white/5 active:scale-[0.98]"
      >
        {/* 状态徽标与动画指示灯 */}
        {runningTaskCount > 0 ? (
          isOnlyImport ? (
            <WizardStatusIcon kind={activeWizardCapsule.statusKind} />
          ) : (
            <span className="relative flex h-2.5 w-2.5 shrink-0 ml-1">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-theme-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-theme-primary" />
            </span>
          )
        ) : completedBackgroundTutorials.length > 0 ? (
          <CheckCircle2 size={16} className="text-emerald-600 dark:text-emerald-400 stroke-[2.5px] ml-0.5 shrink-0" />
        ) : (
          <AlertTriangle size={16} className="text-theme-accent ml-0.5 shrink-0" />
        )}

        {/* 动态单行摘要文案 */}
        <div className="flex flex-col items-start min-w-0 text-left">
          {runningTaskCount === 1 ? (
            isImportActive ? (
              <>
                <div className="flex items-center gap-1.5 min-w-0 max-w-[260px]">
                  <BookOpen className="w-3 h-3 text-theme-primary shrink-0" />
                  <span className="text-xs font-semibold font-mono text-theme-foreground truncate">
                    {wizardRepoLabel}
                  </span>
                  <WizardStatusBadge
                    kind={activeWizardCapsule.statusKind}
                    label={activeWizardCapsule.badgeLabel}
                  />
                </div>
                <span className="text-micro text-theme-muted truncate max-w-[280px]">
                  {activeWizardCapsule.detailText}
                </span>
              </>
            ) : isCurrentDocIngestActive && currentCourseLifecycle ? (
              <>
                <span className="flex items-center gap-1.5 text-xs font-semibold font-mono text-theme-foreground truncate max-w-[240px]">
                  <span className="truncate">{currentDocRepo}</span>
                  <span className="text-theme-primary text-caption font-semibold">
                    {currentCourseLifecycle.processed}/{currentCourseLifecycle.total}
                  </span>
                </span>
                <span className="text-micro text-theme-muted truncate max-w-[260px]">
                  {currentActiveTitle ? `⚡ ${currentActiveTitle}` : m.status_processing()}
                </span>
              </>
            ) : runningBackgroundTutorials[0] ? (
              <>
                <span className="flex items-center gap-1.5 text-xs font-semibold font-mono text-theme-foreground truncate max-w-[240px]">
                  <span className="truncate">{runningBackgroundTutorials[0].title}</span>
                  {runningBackgroundTutorials[0].totalChapters > 0 && (
                    <span className="text-theme-primary text-caption font-semibold">
                      {runningBackgroundTutorials[0].completedChapters}/{runningBackgroundTutorials[0].totalChapters}
                    </span>
                  )}
                </span>
                <span className="text-micro text-theme-muted truncate max-w-[260px]">
                  {runningBackgroundTutorials[0].activeChapterTitle
                    ? `⚡ ${runningBackgroundTutorials[0].activeChapterTitle}`
                    : m.status_processing()}
                </span>
              </>
            ) : relayActiveTask ? (
              <>
                <span className="text-xs font-semibold text-theme-foreground truncate max-w-[240px]">
                  {relayActiveTask.title}
                </span>
                <span className="text-micro text-theme-muted truncate max-w-[260px]">
                  {m.dock_relay_running({ seconds: relayElapsed })}
                </span>
              </>
            ) : null
          ) : runningTaskCount > 1 ? (
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-semibold text-theme-foreground/90 truncate">
                {m.dock_tasks_running_count({ count: runningTaskCount })}
              </span>
            </div>
          ) : completedBackgroundTutorials.length === 1 && errorBackgroundTutorials.length === 0 ? (
            <>
              <span className="text-xs font-semibold text-theme-foreground truncate max-w-[240px]">
                {completedBackgroundTutorials[0].title}
              </span>
              <span className="text-micro text-emerald-600 dark:text-emerald-400 font-medium truncate max-w-[260px]">
                {m.tutorial_dock_all_done()} {m.dock_click_to_read()}
              </span>
            </>
          ) : completedBackgroundTutorials.length > 1 ? (
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-semibold text-theme-foreground/90 truncate">
                {m.dock_tutorials_completed_count({ count: completedBackgroundTutorials.length })}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-semibold text-theme-foreground/90 truncate">
                {m.dock_attention_needed()}
              </span>
            </div>
          )}
        </div>

        {/* 展开角标与任务总数 */}
        {!isOnlyImport && (
          <div className="flex items-center gap-1.5 shrink-0 pl-1 border-l border-theme-border/50 text-theme-muted">
            <span className="px-1.5 py-0.2 rounded-full text-micro font-bold bg-theme-primary/15 text-theme-primary font-mono">
              {totalDockCount}
            </span>
            <ChevronUp
              size={13}
              className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
            />
          </div>
        )}
      </button>
    </div>
  );
}

export function UnifiedTaskDock() {
  return (
    <Suspense fallback={null}>
      <UnifiedTaskDockInner />
    </Suspense>
  );
}
