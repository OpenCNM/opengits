'use client';
import * as m from '@/paraglide/messages';

import { useRouter } from 'next/navigation';
import { toastManager } from '@/components/ui/toast';
import { PublishConfirmDialog } from '@/components/publish/PublishConfirmDialog';
import { PublishProgressModal } from '@/components/publish/PublishProgressModal';

import { usePublishState } from '../hooks/usePublishState';

interface PublishNavButtonProps {
  owner: string;
  repo: string;
  isPublic?: boolean;
  publishedAt?: string;
  reviewStatus?: string | null;
  rejectionReason?: string | null;
  /** 未转录章节数（超阈值时发布框展示「社区接力」选项） */
  unprocessedCount?: number;
}

export function PublishNavButton({
  owner,
  repo,
  isPublic,
  publishedAt,
  reviewStatus,
  rejectionReason,
  unprocessedCount = 0,
}: PublishNavButtonProps) {
  const router = useRouter();
  const {
    isConfirmOpen,
    setIsConfirmOpen,
    isProgressOpen,
    setIsProgressOpen,
    relayEnabled,
    setRelayEnabled,
    publishedState,
    setPublishedState,
    reviewState,
    setReviewState,
  } = usePublishState({
    isPublic,
    publishedAt,
    reviewStatus,
    rejectionReason,
  });

  if (publishedState.isPublic) {
    // 公开发布即成为公共资产，详情页无需常驻展示「已公开」标签，还读者清爽阅读界面
    return null;
  }

  // 安全复核中（LLM 安全拦截，唯一扣留场景）：展示状态徽标，禁止重复提交
  if (reviewState.status === 'PENDING') {
    return (
      <button
        type="button"
        disabled
        className="px-2.5 py-1 rounded-md bg-theme-surface text-theme-muted border border-theme-border text-xs font-serif font-medium shrink-0 cursor-default"
        title={m.reader_review_safety_pending_title()}
      >
        {m.reader_review_safety_pending()}
      </button>
    );
  }

  const isResubmit = reviewState.status === 'REJECTED';

  return (
    <>
      <button
        type="button"
        onClick={() => setIsConfirmOpen(true)}
        className={`px-2.5 py-1 rounded-md hover:bg-theme-surface text-theme-foreground border transition-all text-xs font-serif font-medium cursor-pointer shrink-0 ${
          isResubmit ? 'border-rose-500/40 text-rose-500' : 'bg-theme-bg border-theme-border'
        }`}
        title={isResubmit ? (reviewState.reason || m.reader_resubmit_hint()) : m.reader_submit_review_title()}
      >
        {isResubmit ? m.reader_resubmit() : m.reader_publish_explore()}
      </button>

      <PublishConfirmDialog
        isOpen={isConfirmOpen}
        onClose={() => setIsConfirmOpen(false)}
        onConfirm={(opts) => {
          setRelayEnabled(opts?.relayEnabled);
          setIsProgressOpen(true);
        }}
        repoTitle={repo}
        owner={owner}
        repo={repo}
        reviewStatus={reviewState.status}
        rejectionReason={reviewState.reason}
        unprocessedCount={unprocessedCount}
      />

      <PublishProgressModal
        isOpen={isProgressOpen}
        onClose={() => setIsProgressOpen(false)}
        owner={owner}
        repo={repo}
        relayEnabled={relayEnabled}
        onSubmitted={() => {
          setReviewState({ status: 'PENDING', reason: null });
          toastManager.add({
            type: 'info',
            title: m.publish_review_submitted_title(),
            description: m.publish_review_submitted_desc(),
          });
          router.refresh();
        }}
        onSuccess={() => {
          setPublishedState({ isPublic: true, publishedAt: new Date().toISOString() });
          toastManager.add({
            type: 'success',
            title: m.toast_publish_success(),
            description: m.publish_success_desc(),
          });
        }}
      />
    </>
  );
}
