'use client';

import React, { useEffect } from 'react';
import { Layers, Minimize2, Users, X } from 'lucide-react';
import { AnimatedModal } from '@/components/ui/AnimatedModal';
import { toastManager } from '@/components/ui/toast';
import { useRelayTaskStore } from '@/lib/stores/relay-task-store';
import { cn } from '@/lib/utils';
import * as m from '@/paraglide/messages';
import { RelayAvatarStack, type RelayParticipant } from './RelayAvatarStack';
import { useUpdateWorkbench } from './workbench/useUpdateWorkbench';
import { RelayGuideView } from './workbench/RelayGuideView';
import { RelaySuccessModal } from './workbench/RelaySuccessModal';
import type { RepoUpdateJobItem } from './workbench/WorkbenchBatchView';

export type { RepoUpdateJobItem };

export interface UpdateWorkbenchModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  owner: string;
  repo: string;
  edition?: string;
  repoInfo?: {
    title?: string;
    description?: string;
    chapterCount?: number;
    processedDocsCount?: number;
    progress?: number;
    edition?: string;
    relay?: {
      total: number;
      done: number;
      inProgress: number;
      participants?: RelayParticipant[];
    };
    relayParticipants?: RelayParticipant[];
    [key: string]: any;
  } | null;
  initialJobId?: string | null;
  isLoggedIn: boolean;
  onJobResolved?: () => void;
}

export function UpdateWorkbenchModal({
  open,
  onOpenChange,
  owner,
  repo,
  edition,
  repoInfo,
  initialJobId,
  isLoggedIn,
  onJobResolved,
}: UpdateWorkbenchModalProps) {
  const effectiveEdition = edition ?? repoInfo?.edition;
  const {
    outline,
    repoMeta,
    loadingJobs,
    claimingNodeId,
    totalCount: hookTotal,
    processedCount: hookProcessed,
    handleSingleClaim,
    successResult,
    setSuccessResult,
  } = useUpdateWorkbench({
    open,
    onOpenChange,
    owner,
    repo,
    edition: effectiveEdition,
    initialJobId,
    isLoggedIn,
    onJobResolved,
  });

  // 综合统计：遵循 File ≠ Cognitive Unit，优先当前激活大纲节点的真实物理统计（hookTotal / repoMeta），
  // 仅在初始未载入大纲时使用父级传入的 repoInfo 兜底，杜绝物理 Document.count 覆盖大纲课时数。
  const totalDocs =
    hookTotal > 0
      ? hookTotal
      : (repoMeta?.totalDocs ?? repoInfo?.relay?.total ?? repoInfo?.chapterCount ?? 0);
  const processedDocs =
    hookTotal > 0
      ? hookProcessed
      : (repoMeta?.processedDocs ?? repoInfo?.relay?.done ?? repoInfo?.processedDocsCount ?? 0);
  const progressPercent =
    totalDocs > 0 ? Math.min(100, Math.round((processedDocs / totalDocs) * 100)) : 0;

  const displayTitle = repoInfo?.title || repoMeta?.title || `${owner}/${repo}`;
  const displayDesc = m.footer_relay();

  const participants: RelayParticipant[] =
    repoInfo?.relay?.participants || repoInfo?.relayParticipants || repoMeta?.participants || [];

  // 同步工作台展开状态至全局任务仓库
  useEffect(() => {
    useRelayTaskStore.getState().setWorkbenchOpen(open);
    return () => {
      useRelayTaskStore.getState().setWorkbenchOpen(false);
    };
  }, [open]);

  const handleRequestClose = () => {
    if (claimingNodeId) {
      toastManager.add({
        type: 'info',
        title: m.relay_minimized_title(),
        description: m.relay_minimized_desc(),
      });
    }
    useRelayTaskStore.getState().setWorkbenchOpen(false);
    onOpenChange(false);
  };

  return (
    <AnimatedModal
      isOpen={open}
      onClose={handleRequestClose}
      size="xl"
      showHeader={false}
      preventBackdropClose={false}
      bodyClassName="flex flex-col min-h-0 overflow-hidden select-none"
    >
      {/* 强化项目身份卡片 Header */}
      <div className="px-5 py-3.5 border-b border-theme-border/70 bg-theme-surface/70 flex items-center justify-between gap-4 shrink-0">
        {/* 左侧：项目标志与名称 */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="w-9 h-9 rounded-xl bg-theme-primary/15 border border-theme-primary/30 flex items-center justify-center text-theme-primary font-serif font-bold text-sm shrink-0 shadow-2xs">
            ❖
          </div>
          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-serif font-bold text-theme-foreground truncate">
                {displayTitle}
              </h3>
              {displayTitle !== `${owner}/${repo}` && displayTitle !== repo && (
                <span className="text-micro font-mono px-1.5 py-0.2 rounded-md bg-theme-bg border border-theme-border text-theme-muted shrink-0">
                  {owner}/{repo}
                </span>
              )}
            </div>
            <p className="text-xs text-theme-muted truncate max-w-md">
              {displayDesc}
            </p>
            {(repoMeta?.qualityHold || repoInfo?.qualityHold) && (
              <p className="text-micro text-amber-600 dark:text-amber-400 flex items-center gap-1">
                <span aria-hidden>⚠</span>
                {m.relay_circuit_breaker_alert()}
              </p>
            )}
          </div>
        </div>

        {/* 右侧：接力进度胶囊 + 贡献者头像 + 关闭/最小化按钮 */}
        <div className="flex items-center gap-2.5 shrink-0">
          {/* 接力总进度胶囊 */}
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-theme-bg border border-theme-border/70 text-xs shadow-2xs">
            <Users className="w-3.5 h-3.5 text-theme-primary shrink-0" />
            <span className="text-theme-muted">{m.relay_progress_badge()}</span>
            <span className="font-mono font-bold text-theme-foreground">
              {progressPercent}%
            </span>
            <span className="text-micro font-mono text-theme-muted">
              ({processedDocs}/{totalDocs})
            </span>
          </div>

          {/* 活跃贡献者头像栈 */}
          {participants.length > 0 && (
            <div className="hidden md:flex items-center">
              <RelayAvatarStack participants={participants} maxVisible={3} size="sm" />
            </div>
          )}

          {/* 关闭/最小化为胶囊按钮 */}
          {claimingNodeId ? (
            <button
              type="button"
              onClick={handleRequestClose}
              title={m.relay_minimize_capsule()}
              aria-label={m.relay_minimize_capsule()}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-theme-primary/10 border border-theme-primary/30 text-theme-primary text-xs hover:bg-theme-primary/20 transition-all cursor-pointer shadow-2xs"
            >
              <Minimize2 className="w-3.5 h-3.5" />
              <span>{m.relay_minimize_capsule()}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleRequestClose}
              aria-label={m.common_close()}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-theme-muted hover:text-theme-foreground hover:bg-theme-bg transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* 极简接力向导主工作区 */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col bg-theme-bg">
        <RelayGuideView
          owner={owner}
          repo={repo}
          outline={outline}
          loadingJobs={loadingJobs}
          initialJobId={initialJobId}
          handleSingleClaim={handleSingleClaim}
          claimingNodeId={claimingNodeId}
        />
      </div>

      {/* 接力转录成功庆典弹窗 */}
      <RelaySuccessModal
        isOpen={successResult !== null}
        onClose={() => {
          setSuccessResult(null);
          useRelayTaskStore.getState().dismissTask();
        }}
        result={successResult}
        onContinueNext={() => {
          setSuccessResult(null);
          useRelayTaskStore.getState().dismissTask();
        }}
      />
    </AnimatedModal>
  );
}
