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

const MAX_TRACK_DURATION_MS = 10 * 60 * 1000;

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

  useEffect(() => {
    const handleVisibilityChange = () => {
      const isVisible = document.visibilityState === 'visible';
      isTabVisibleRef.current = isVisible;

      if (isVisible) {
        activeStartRef.current = Date.now();
      } else {
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

  useEffect(() => {
    if (isOpen) {
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

      sessionStartRef.current = null;
      activeStartRef.current = null;
      accumulatedActiveMsRef.current = 0;
    }
  }, [isOpen, step, subStep, url, loading, prefixLoading, scoutData, ingestSuccessInfo, ingestFailed, scoutError]);

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
