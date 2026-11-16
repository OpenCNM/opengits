'use client';

import { useEffect, useRef } from 'react';
import { trackEvent, TELEMETRY_EVENTS } from '@/lib/telemetry/beacon';
import type { ImportAbandonStage, ImportAbandonReason } from '@/lib/telemetry/events';

interface ImportWizardObserverState {
  isOpen: boolean;
  step: number;
  subStep: string;
  url: string;
  loading: boolean;
  prefixLoading: boolean;
  scoutData: any;
  ingestSuccessInfo: any;
  ingestFailed: boolean;
  scoutError: any;
}

const MAX_TRACK_DURATION_MS = 10 * 60 * 1000; // 最大 10 分钟硬截断，剔除挂机

/**
 * 导入旅程全自动状态机观察者 Hook（非侵入式架构）
 *
 * 自动感知 ImportWizard 生命周期变迁，零侵入业务处理逻辑：
 * 1. 自动计算有效活跃等待时长（通过 Page Visibility API 自动扣除切后台休眠时长）
 * 2. 自动捕获中途流失放弃事件（含已等候毫秒数、流失阶段与主动/被动原因）
 * 3. 自动捕获各阶段里程碑耗时（Scout 耗时、转录耗时、成功达成）
 */
export function useImportJourneyTracker(state: ImportWizardObserverState) {
  const {
    isOpen,
    step,
    subStep,
    url,
    loading,
    prefixLoading,
    scoutData,
    ingestSuccessInfo,
    ingestFailed,
    scoutError,
  } = state;

  const sessionStartRef = useRef<number | null>(null);
  const activeStartRef = useRef<number | null>(null);
  const accumulatedActiveMsRef = useRef<number>(0);
  const isTabVisibleRef = useRef<boolean>(true);
  const stageStartTimeRef = useRef<number>(Date.now());
  const hasInitiatedRef = useRef<boolean>(false);
  const hasScoutCompletedRef = useRef<boolean>(false);
  const hasIngestStartedRef = useRef<boolean>(false);
  const hasCompletedRef = useRef<boolean>(false);

  // 1. Page Visibility API: 标签页切后台自动暂停计时
  useEffect(() => {
    const handleVisibilityChange = () => {
      const isVisible = document.visibilityState === 'visible';
      isTabVisibleRef.current = isVisible;

      if (isVisible) {
        // 切回前台：恢复计时
        activeStartRef.current = Date.now();
      } else {
        // 切到后台：累加已活跃时长并暂停
        if (activeStartRef.current) {
          accumulatedActiveMsRef.current += Date.now() - activeStartRef.current;
          activeStartRef.current = null;
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const getActiveDwellMs = (): number => {
    let activeMs = accumulatedActiveMsRef.current;
    if (isTabVisibleRef.current && activeStartRef.current) {
      activeMs += Date.now() - activeStartRef.current;
    }
    return Math.min(Math.max(0, activeMs), MAX_TRACK_DURATION_MS);
  };

  const getCurrentStage = (): ImportAbandonStage => {
    if (step === 3) return 'ingesting';
    if (step === 2) return 'outline_draft';
    if (loading || prefixLoading) return 'scout_loading';
    if (subStep === 'directory_confirm') return 'directory_confirm';
    return 'input';
  };

  // 2. 导入生命周期状态机监听
  useEffect(() => {
    if (isOpen) {
      // 开启弹窗 / 启动新会话
      if (!sessionStartRef.current) {
        sessionStartRef.current = Date.now();
        activeStartRef.current = Date.now();
        accumulatedActiveMsRef.current = 0;
        stageStartTimeRef.current = Date.now();
        hasInitiatedRef.current = false;
        hasScoutCompletedRef.current = false;
        hasIngestStartedRef.current = false;
        hasCompletedRef.current = false;
      }

      // 里程碑 1：发起解析
      if (url && (loading || prefixLoading || step > 1) && !hasInitiatedRef.current) {
        hasInitiatedRef.current = true;
        const owner = scoutData?.owner || url.split('/')[3] || '';
        const repo = scoutData?.repo || url.split('/')[4]?.replace(/\.git$/, '') || '';

        trackEvent({
          eventType: TELEMETRY_EVENTS.IMPORT_INITIATED,
          targetId: url,
          metadata: {
            url,
            owner,
            repo,
            scopeMode: scoutData?.isGiantRepo ? 'giant_scope' : 'full_repo',
          },
        });
      }

      // 里程碑 2：大纲勘测完成
      if (step === 2 && !hasScoutCompletedRef.current && scoutData) {
        hasScoutCompletedRef.current = true;
        const scoutDuration = Date.now() - stageStartTimeRef.current;
        stageStartTimeRef.current = Date.now();

        trackEvent({
          eventType: TELEMETRY_EVENTS.IMPORT_SCOUT_COMPLETED,
          targetId: `${scoutData.owner}/${scoutData.repo}`,
          duration: Math.min(scoutDuration, MAX_TRACK_DURATION_MS),
          metadata: {
            owner: scoutData.owner,
            repo: scoutData.repo,
            durationMs: scoutDuration,
            categoriesCount: scoutData.categories?.length || 0,
            filesCount: scoutData.totalFiles || 0,
            isGiantRepo: Boolean(scoutData.isGiantRepo),
          },
        });
      }

      // 里程碑 3：进入转录生成等待
      if (step === 3 && !hasIngestStartedRef.current && scoutData) {
        hasIngestStartedRef.current = true;
        stageStartTimeRef.current = Date.now();

        trackEvent({
          eventType: TELEMETRY_EVENTS.IMPORT_INGEST_STARTED,
          targetId: `${scoutData.owner}/${scoutData.repo}`,
          metadata: {
            owner: scoutData.owner,
            repo: scoutData.repo,
          },
        });
      }

      // 里程碑 4：转录全部成功完成
      if (ingestSuccessInfo && !hasCompletedRef.current) {
        hasCompletedRef.current = true;
        const totalWaitMs = sessionStartRef.current ? Date.now() - sessionStartRef.current : 0;
        const activeWaitMs = getActiveDwellMs();

        trackEvent({
          eventType: TELEMETRY_EVENTS.IMPORT_INGEST_COMPLETED,
          targetId: `${ingestSuccessInfo.owner}/${ingestSuccessInfo.repo}`,
          duration: Math.min(activeWaitMs, MAX_TRACK_DURATION_MS),
          metadata: {
            owner: ingestSuccessInfo.owner,
            repo: ingestSuccessInfo.repo,
            totalDurationMs: totalWaitMs,
            activeDwellMs: activeWaitMs,
          },
          immediate: true,
        });
      }
    } else {
      // 弹窗被关闭 / 退出：如果未完成则自动判定为流失放弃
      if (sessionStartRef.current && !hasCompletedRef.current && (hasInitiatedRef.current || url)) {
        const waitMs = Date.now() - sessionStartRef.current;
        const activeMs = getActiveDwellMs();
        const stage = getCurrentStage();
        const reason: ImportAbandonReason = ingestFailed || scoutError ? 'ERROR_DROPOFF' : 'USER_CANCELLED';

        trackEvent({
          eventType: TELEMETRY_EVENTS.IMPORT_ABANDONED,
          targetId: url || 'unknown_import',
          duration: Math.min(activeMs, MAX_TRACK_DURATION_MS),
          metadata: {
            stage,
            waitDurationMs: Math.min(waitMs, MAX_TRACK_DURATION_MS),
            activeDwellMs: activeMs,
            reason,
            url,
            isPassive: false,
          },
          immediate: true,
        });
      }

      // 重置会话引用
      sessionStartRef.current = null;
      activeStartRef.current = null;
      accumulatedActiveMsRef.current = 0;
    }
  }, [isOpen, step, subStep, url, loading, prefixLoading, scoutData, ingestSuccessInfo, ingestFailed, scoutError]);

  // 3. 页面被动关闭 / 刷新 (beforeunload) 兜底捕获
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (isOpen && sessionStartRef.current && !hasCompletedRef.current && hasInitiatedRef.current) {
        const waitMs = Date.now() - sessionStartRef.current;
        const activeMs = getActiveDwellMs();
        const stage = getCurrentStage();

        trackEvent({
          eventType: TELEMETRY_EVENTS.IMPORT_ABANDONED,
          targetId: url || 'unknown_import',
          duration: Math.min(activeMs, MAX_TRACK_DURATION_MS),
          metadata: {
            stage,
            waitDurationMs: Math.min(waitMs, MAX_TRACK_DURATION_MS),
            activeDwellMs: activeMs,
            reason: 'TAB_CLOSED',
            url,
            isPassive: true,
          },
          immediate: true,
        });
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isOpen, url]);
}
