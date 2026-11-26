'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toastManager } from '@/components/ui/toast';
import { api, ApiClientError } from '@/lib/api/client';
import { trackEvent, TELEMETRY_EVENTS } from '@/lib/telemetry/beacon';
import { STORAGE_KEYS } from '@/lib/constants';
import * as m from '@/paraglide/messages';
import type { ArchitectureDrift } from '@/engine/update-candidate-set';

export interface PlanChapter {
  path: string;
  action: 'update' | 'keep' | 'remove' | 'add';
  position?: string;
  title?: string;
  reason: string;
  evidence: string;
}

export interface UpdatePlanResponse {
  runId?: string;
  plan?: {
    chapters: PlanChapter[];
    summary: string;
    isFallback?: boolean;
    fallbackReason?: string;
  };
  diffStats?: { added: number; modified: number; removed: number; renamed: number };
  architectureDrift?: ArchitectureDrift;
  noChanges?: boolean;
  message?: string;
  error?: string;
}

export type Phase = 'idle' | 'init' | 'loading' | 'preview' | 'applying' | 'done' | 'error';

export function getActionLabels(): Record<PlanChapter['action'], string> {
  return {
    update: m.toast_updated(),
    keep: m.status_completed(),
    remove: m.common_delete(),
    add: m.common_create(),
  };
}

export const ACTION_STYLE: Record<PlanChapter['action'], string> = {
  update: 'bg-theme-primary/15 text-theme-primary border border-theme-primary/30',
  keep: 'bg-theme-surface border border-theme-border text-theme-muted',
  remove: 'bg-red-500/10 text-red-600 border border-red-500/30',
  add: 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/30',
};

interface UseUpdatePlanWorkflowOptions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  owner: string;
  repo: string;
  branch?: string;
  edition?: string;
  onUpdated?: () => void;
}

export function useUpdatePlanWorkflow({
  open,
  onOpenChange,
  owner,
  repo,
  branch,
  edition,
  onUpdated,
}: UseUpdatePlanWorkflowOptions) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [runId, setRunId] = useState<string | null>(null);
  const [plan, setPlan] = useState<UpdatePlanResponse['plan'] | null>(null);
  const [diffStats, setDiffStats] = useState<UpdatePlanResponse['diffStats'] | null>(null);
  const [architectureDrift, setArchitectureDrift] = useState<ArchitectureDrift | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progressText, setProgressText] = useState<string>('');
  const abortRef = useRef<AbortController | null>(null);
  const [loadingStageText, setLoadingStageText] = useState<string>(m.update_stage_diff());

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase('idle');
    setRunId(null);
    setPlan(null);
    setDiffStats(null);
    setArchitectureDrift(null);
    setError(null);
    setProgressText('');
    setLoadingStageText(m.update_stage_diff());
  }, []);

  const handleStartAnalysis = useCallback(() => {
    setPhase('loading');
    setError(null);
    setLoadingStageText(m.update_stage_diff());

    const t1 = setTimeout(() => setLoadingStageText(m.update_stage_impact()), 400);
    const t2 = setTimeout(() => setLoadingStageText(m.update_stage_plan()), 1200);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const params = new URLSearchParams();
    if (branch) params.set('branch', branch);
    if (edition) params.set('edition', edition);
    const queryString = params.toString() ? `?${params.toString()}` : '';

    api
      .post<UpdatePlanResponse>(`/api/update/${owner}/${repo}/plan${queryString}`, { branch, edition }, {
        signal: ctrl.signal,
        onUnauthorized: 'throw',
      })
      .then((data) => {
        clearTimeout(t1);
        clearTimeout(t2);
        if (data.noChanges) {
          toastManager.add({
            type: 'info',
            title: m.toast_already_latest(),
            description: m.toast_latest_synced_desc(),
          });
          onOpenChange(false);
          return;
        }
        setRunId(data.runId ?? null);
        setPlan(data.plan ?? null);
        setDiffStats(data.diffStats ?? null);
        setArchitectureDrift(data.architectureDrift ?? null);
        setPhase('preview');
      })
      .catch((err) => {
        clearTimeout(t1);
        clearTimeout(t2);
        if ((err as Error | undefined)?.name === 'AbortError') return;
        if (err instanceof ApiClientError && err.code === 'NO_UPDATE') {
          toastManager.add({
            type: 'success',
            title: m.toast_already_latest(),
            description: m.toast_latest_synced_desc(),
          });
          onOpenChange(false);
          return;
        }
        setError((err as Error | undefined)?.message || m.update_plan_generate_failed());
        setPhase('error');
      });
  }, [owner, repo, branch, edition, onOpenChange]);

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    handleStartAnalysis();
  }, [open, handleStartAnalysis, reset]);

  const handleApply = useCallback(async () => {
    if (!runId) return;
    setPhase('applying');
    setError(null);
    setProgressText(m.update_stage_applying());
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const params = new URLSearchParams();
      if (branch) params.set('branch', branch);
      if (edition) params.set('edition', edition);
      const queryString = params.toString() ? `?${params.toString()}` : '';

      const res = await fetch(`/api/update/${owner}/${repo}/apply${queryString}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, branch, edition }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as UpdatePlanResponse;
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error(m.update_plan_stream_unavailable());

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;
          const evt = JSON.parse(line.slice(5)) as { type: string; [key: string]: any };
          if (evt.type === 'plan_applied') {
            setProgressText(m.update_plan_applied_desc());
          } else if (evt.type === 'transcription_started') {
            setProgressText(m.update_running_in_background());
          } else if (evt.type === 'done') {
            setPhase('done');
            setProgressText(m.common_done());
            trackEvent({
              eventType: TELEMETRY_EVENTS.UPSTREAM_UPDATE_APPLIED,
              metadata: { owner, repo, runId },
            });
            try {
              localStorage.removeItem(STORAGE_KEYS.UPDATE_TOAST_PREF(owner, repo));
              sessionStorage.removeItem(`update_toast_dismissed_${owner}_${repo}`);
            } catch {}
            toastManager.add({
              type: 'success',
              title: m.toast_updated(),
              description: m.update_plan_applied_desc(),
            });
            onUpdated?.();
            router.refresh();
            setTimeout(() => onOpenChange(false), 800);
            return;
          } else if (evt.type === 'error') {
            throw new Error(evt.error || m.update_plan_apply_failed());
          }
        }
      }
    } catch (err) {
      if ((err as Error | undefined)?.name === 'AbortError') return;
      setError((err as Error | undefined)?.message || m.update_plan_apply_failed());
      setPhase('error');
    }
  }, [runId, owner, repo, branch, edition, onOpenChange, onUpdated, router]);

  return {
    phase,
    runId,
    plan,
    diffStats,
    architectureDrift,
    error,
    progressText,
    loadingStageText,
    handleStartAnalysis,
    retryPlan: handleStartAnalysis,
    handleApply,
    reset,
  };
}
