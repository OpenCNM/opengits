'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DisplayRepo, EditionChip } from '@/lib/home-data';
import { api, ApiClientError } from '@/lib/api/client';
import { toastManager } from '@/components/ui/toast';
import { subscribeImportJob, type ImportJobSubscription } from '@/lib/jobs/import-job-subscription';
import * as m from '@/paraglide/messages';

export function useDashboardRepoActions() {
  const router = useRouter();
  const [updateTarget, setUpdateTarget] = useState<{
    owner: string;
    repo: string;
    branch?: string;
    edition?: string;
  } | null>(null);
  const [checkingRepoId, setCheckingRepoId] = useState<string | null>(null);
  const [editionSavedOverrides, setEditionSavedOverrides] = useState<Record<string, boolean>>({});
  const [followOverrides, setFollowOverrides] = useState<Record<string, boolean>>({});
  const [pinnedOverrides, setPinnedOverrides] = useState<Record<string, boolean>>({});
  const [updateStatusOverrides, setUpdateStatusOverrides] = useState<Record<string, boolean>>({});

  // 活跃 web-sync 任务订阅（性能修复 2026-10-13：手写 2s setInterval 无退避、
  // 组件卸载不清理——离开首页后最长空转 10 分钟。迁移到 subscribeImportJob
  // 统一基建：SSE 优先 + 轮询降级 + 终态自动停；卸载时统一释放）
  const webSyncSubscriptionsRef = useRef(new Set<ImportJobSubscription>());
  useEffect(() => {
    const subs = webSyncSubscriptionsRef.current;
    return () => {
      for (const sub of subs) sub.stop();
      subs.clear();
    };
  }, []);

  const handleEditionSavedChange = (chip: EditionChip, isSaved: boolean) => {
    setEditionSavedOverrides((prev) => ({ ...prev, [chip.id]: isSaved }));
  };

  // Toggle Pin (optimistic update + rollback on error)
  const handleTogglePin = async (repo: DisplayRepo) => {
    const currentPinned = pinnedOverrides[repo.id] ?? repo.isPinned;
    const next = !currentPinned;
    setPinnedOverrides((prev) => ({ ...prev, [repo.id]: next }));
    try {
      await api.post('/api/repositories/pin', { repositoryId: repo.id, isPinned: next });
      toastManager.add({
        type: 'success',
        title: next ? m.dashboard_pin_done() : m.dashboard_unpin_done(),
      });
      router.refresh();
    } catch (err: any) {
      setPinnedOverrides((prev) => ({ ...prev, [repo.id]: currentPinned }));
      toastManager.add({
        type: 'warning',
        title: m.toast_save_failed(),
        description: err?.message || m.common_retry_later(),
      });
    }
  };

  // Web-sync Job 订阅：复用 ImportJob 统一基建（SSE 优先 + Last-Event-ID 续传 +
  // 2s 轮询降级 + 终态自动停 + AbortSignal）。web-sync 任务即 ImportJob(kind:'web-sync')。
  // 终态语义：done→成功 toast + 刷新；error→失败 toast；gone/aborted→静默。
  // 注：ImportJob 状态机无 CANCELLED（原轮询的该分支为防御性死代码，已随迁移移除）。
  const trackWebSyncJob = (jobId: string, owner: string, repo: string) => {
    const sub = subscribeImportJob(jobId, {
      onEvent: (ev) => {
        if (ev.type === 'done') {
          toastManager.add({
            type: 'success',
            title: m.dashboard_websync_done_title(),
            description: `${owner}/${repo}`,
          });
          router.refresh();
        } else if (ev.type === 'error') {
          toastManager.add({
            type: 'error',
            title: m.toast_action_failed(),
            description: (ev.message as string) || m.common_retry_later(),
          });
        }
      },
      onClose: () => undefined,
    });
    webSyncSubscriptionsRef.current.add(sub);
  };

  const handleToggleFollow = async (repo: DisplayRepo, next: boolean) => {
    setFollowOverrides((prev) => ({ ...prev, [repo.id]: next }));
    try {
      await api.post('/api/repos', { action: 'follow', repositoryId: repo.id, value: next });
      toastManager.add({
        type: 'success',
        title: next ? m.dashboard_follow_on_title() : m.dashboard_follow_off_title(),
      });
    } catch (err: any) {
      setFollowOverrides((prev) => ({ ...prev, [repo.id]: !next }));
      toastManager.add({
        type: 'warning',
        title: m.toast_save_failed(),
        description: err?.message || m.common_retry_later(),
      });
    }
  };

  const handleCheckAndUpdate = async (targetRepo: DisplayRepo, targetEdition?: EditionChip) => {
    if (!targetRepo?.owner || !targetRepo?.repo || !targetRepo?.id) return;
    const repoIdToCheck = targetEdition?.id || targetRepo.id;
    if (checkingRepoId) return;
    setCheckingRepoId(repoIdToCheck);
    try {
      const profile = (targetRepo as { repoProfile?: Record<string, unknown> }).repoProfile;
      if (profile?.sourceType === 'web') {
        const data = await api.post<{
          jobId?: string;
          deduped?: boolean;
          reused?: boolean;
          message?: string;
        }>(`/api/repos/${targetRepo.owner}/${targetRepo.repo}/web-sync`);
        if (data.jobId) {
          toastManager.add({
            type: 'info',
            title: m.dashboard_websync_started_title(),
            description: m.dashboard_websync_started_desc(),
          });
          void trackWebSyncJob(data.jobId, targetRepo.owner, targetRepo.repo);
        } else if (data.reused) {
          toastManager.add({ type: 'success', title: data.message || m.toast_already_latest() });
        } else {
          toastManager.add({
            type: 'warning',
            title: m.toast_action_failed(),
            description: m.common_retry_later(),
          });
        }
        return;
      }

      const branch = targetEdition?.branch || targetRepo.branch;
      const edition = targetEdition?.edition ?? (targetRepo.edition ?? '');

      const params = new URLSearchParams();
      if (branch) params.set('branch', branch);
      if (edition) params.set('edition', edition);
      const queryString = params.toString() ? `?${params.toString()}` : '';

      const data = await api.post<{ hasUpdate?: boolean }>(
        `/api/update/${targetRepo.owner}/${targetRepo.repo}/check${queryString}`,
        { branch, edition }
      );
      const hasUpdate = Boolean(data.hasUpdate);
      setUpdateStatusOverrides((prev) => ({ ...prev, [repoIdToCheck]: hasUpdate }));

      if (hasUpdate) {
        setUpdateTarget({
          owner: targetRepo.owner,
          repo: targetRepo.repo,
          branch,
          edition,
        });
      } else {
        toastManager.add({
          type: 'success',
          title: m.toast_already_latest(),
          description: m.toast_latest_synced_desc(),
        });
      }
    } catch (err: any) {
      if (err instanceof ApiClientError && err.code === 'NO_IMPORT') {
        setUpdateStatusOverrides((prev) => ({ ...prev, [repoIdToCheck]: false }));
        toastManager.add({
          type: 'info',
          title: m.toast_already_latest(),
          description: m.toast_latest_synced_desc(),
        });
        return;
      }
      toastManager.add({
        type: 'warning',
        title: m.toast_action_failed(),
        description: err?.message || m.toast_network_timeout(),
      });
    } finally {
      setCheckingRepoId(null);
    }
  };

  return {
    updateTarget,
    setUpdateTarget,
    checkingRepoId,
    editionSavedOverrides,
    followOverrides,
    pinnedOverrides,
    updateStatusOverrides,
    handleEditionSavedChange,
    handleTogglePin,
    handleToggleFollow,
    handleCheckAndUpdate,
  };
}
