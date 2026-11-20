'use client';

import React, { useMemo, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import {
  Dialog,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toastManager } from '@/components/ui/toast';
import { api } from '@/lib/api/client';
import type { StarterPackItem, StarterPackRepoItem } from '@/lib/starter-packs/starter-packs';
import * as m from '@/paraglide/messages';

export interface StarterPackOnboardingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packs: StarterPackItem[];
  isFirstTimeOnboarding?: boolean;
  onApplied?: (addedRepoIds: string[]) => void;
  onSkipped?: () => void;
}

export function StarterPackOnboardingDialog({
  open,
  onOpenChange,
  packs,
  isFirstTimeOnboarding = false,
  onApplied,
  onSkipped,
}: StarterPackOnboardingDialogProps) {
  const [selectedPackIds, setSelectedPackIds] = useState<Set<string>>(() => {
    const first = packs[0]?.id;
    return first ? new Set([first]) : new Set();
  });
  const [excludedRepoIds, setExcludedRepoIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  // 当 packs 异步加载完成且尚未选过任何包时，默认选中第一个推荐场景
  React.useEffect(() => {
    if (open && packs.length > 0 && selectedPackIds.size === 0) {
      setSelectedPackIds(new Set([packs[0].id]));
    }
  }, [open, packs, selectedPackIds.size]);

  const togglePack = (packId: string) => {
    setSelectedPackIds((prev) => {
      const next = new Set(prev);
      if (next.has(packId)) {
        next.delete(packId);
      } else {
        next.add(packId);
      }
      return next;
    });
  };

  const chosenRepos = useMemo(() => {
    const map = new Map<string, StarterPackRepoItem>();
    for (const pack of packs) {
      if (!selectedPackIds.has(pack.id)) continue;
      for (const repo of pack.repos) {
        if (!excludedRepoIds.has(repo.id) && !map.has(repo.id)) {
          map.set(repo.id, repo);
        }
      }
    }
    return Array.from(map.values());
  }, [packs, selectedPackIds, excludedRepoIds]);

  const newReposCount = useMemo(
    () => chosenRepos.filter((r) => !r.isSaved).length,
    [chosenRepos]
  );

  const handleSkip = async () => {
    if (!isFirstTimeOnboarding) {
      onOpenChange(false);
      return;
    }
    try {
      setSubmitting(true);
      await api.post('/api/user/starter-packs/apply', { skip: true });
      onSkipped?.();
      onOpenChange(false);
    } catch (err) {
      // 容错降级: 跳过引导持久化失败时不阻塞用户关闭弹窗进入工作台
      console.warn('[StarterPackOnboardingDialog] skip failed:', err);
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleApply = async () => {
    if (selectedPackIds.size === 0 || chosenRepos.length === 0) {
      await handleSkip();
      return;
    }
    try {
      setSubmitting(true);
      const res = await api.post<{ addedRepoIds?: string[] }>('/api/user/starter-packs/apply', {
        bundleIds: Array.from(selectedPackIds),
        repositoryIds: chosenRepos.map((r) => r.id),
      });
      const addedCount = res?.addedRepoIds?.length ?? newReposCount;
      toastManager.add({
        type: 'success',
        title: m.starter_pack_applied_title(),
        description: m.starter_pack_applied_desc({ count: String(addedCount) }),
      });
      onApplied?.(res?.addedRepoIds || []);
      onOpenChange(false);
    } catch (err: unknown) {
      toastManager.add({
        type: 'error',
        title: m.toast_action_failed(),
        description: err instanceof Error ? err.message : m.common_retry_later(),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen && isFirstTimeOnboarding && !submitting) {
        void handleSkip();
        return;
      }
      onOpenChange(nextOpen);
    }}>
      <DialogPopup
        showCloseButton={false}
        className="max-w-lg rounded-3xl bg-theme-bg/95 backdrop-blur-xl border border-theme-border shadow-2xl p-6 sm:p-7 space-y-6"
      >
        {/* 顶部极简标题区 */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-xs font-medium text-theme-muted tracking-wide flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-theme-primary" />
              <span>{m.starter_pack_eyebrow()}</span>
            </p>
            <DialogTitle className="text-lg font-semibold tracking-tight text-theme-foreground">
              {m.starter_pack_title()}
            </DialogTitle>
          </div>
          <button
            type="button"
            onClick={handleSkip}
            disabled={submitting}
            className="w-7 h-7 rounded-full flex items-center justify-center text-theme-muted hover:bg-theme-surface hover:text-theme-foreground transition-colors cursor-pointer"
            aria-label={m.starter_pack_close()}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 流体胶囊云 */}
        <div className="flex flex-wrap gap-2.5">
          {packs.map((pack) => {
            const active = selectedPackIds.has(pack.id);
            return (
              <button
                key={pack.id}
                type="button"
                onClick={() => togglePack(pack.id)}
                className={`px-4 py-2.5 rounded-full text-xs font-medium border transition-all duration-200 cursor-pointer flex items-center gap-2 ${
                  active
                    ? 'bg-theme-primary text-theme-primary-fg border-theme-primary shadow-sm -translate-y-0.5'
                    : 'bg-theme-surface/70 text-theme-foreground border-theme-border hover:border-theme-muted/60 hover:bg-theme-surface'
                }`}
              >
                <span>{pack.starterCategory || pack.title}</span>
              </button>
            );
          })}
        </div>

        {/* 渐进式免费书签预览条 */}
        <div className="rounded-2xl bg-theme-surface/50 border border-theme-border/80 p-3.5 space-y-2.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-theme-muted">{m.starter_pack_preview_label()}</span>
            {excludedRepoIds.size > 0 ? (
              <button
                type="button"
                onClick={() => setExcludedRepoIds(new Set())}
                className="text-theme-primary hover:underline cursor-pointer"
              >
                {m.starter_pack_restore_all()}
              </button>
            ) : (
              <span className="font-mono text-theme-muted">{chosenRepos.length}</span>
            )}
          </div>

          {chosenRepos.length === 0 ? (
            <p className="text-xs text-theme-muted py-1">{m.starter_pack_empty_hint()}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
              {chosenRepos.map((repo) => (
                <span
                  key={repo.id}
                  className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full bg-theme-bg border border-theme-border text-xs font-mono text-theme-foreground"
                >
                  <span className="truncate max-w-[180px]">{repo.owner}/{repo.repo}</span>
                  {repo.isSaved ? (
                    <span className="text-micro font-sans text-theme-muted px-1">
                      {m.starter_pack_already_saved()}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        setExcludedRepoIds((prev) => new Set([...prev, repo.id]))
                      }
                      className="w-4 h-4 rounded-full hover:bg-theme-surface text-theme-muted hover:text-theme-foreground flex items-center justify-center cursor-pointer"
                      aria-label={`Remove ${repo.owner}/${repo.repo}`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* 极简底部操作区 */}
        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            onClick={handleSkip}
            disabled={submitting}
            className="text-xs text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer"
          >
            {isFirstTimeOnboarding ? m.starter_pack_skip() : m.starter_pack_close()}
          </button>

          <Button
            type="button"
            onClick={handleApply}
            disabled={submitting || chosenRepos.length === 0}
            className="rounded-full px-5 py-2 text-xs font-semibold"
          >
            {submitting
              ? m.starter_pack_applying()
              : `${m.starter_pack_apply()}${
                  newReposCount > 0
                    ? m.starter_pack_apply_count({ count: String(newReposCount) })
                    : ''
                }`}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
