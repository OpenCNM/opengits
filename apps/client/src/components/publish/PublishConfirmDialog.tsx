'use client';

import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import * as m from '@/paraglide/messages';

interface PublishConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (opts?: { relayEnabled?: boolean }) => void;
  repoTitle: string;
  owner: string;
  repo: string;
  /** 审核流状态：REJECTED 时展示上次驳回理由，按钮改「重新提交审核」 */
  reviewStatus?: string | null;
  rejectionReason?: string | null;
  /** 未转录章节数（> 阈值时展示「社区接力」选项；docs 页装配传入） */
  unprocessedCount?: number;
  /** 巨仓默认开启接力的阈值（中央常量，避免散落魔法数） */
  relayThreshold?: number;
}

/** 超过该未转录章节数即视为"巨仓"并默认开启接力 */
const DEFAULT_RELAY_THRESHOLD = 20;

export function PublishConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  repoTitle,
  owner,
  repo,
  reviewStatus,
  rejectionReason,
  unprocessedCount = 0,
  relayThreshold = DEFAULT_RELAY_THRESHOLD,
}: PublishConfirmDialogProps) {
  const isResubmit = reviewStatus === 'REJECTED';
  const showRelay = unprocessedCount > relayThreshold;
  const [relayEnabled, setRelayEnabled] = useState(showRelay);

  // 巨仓（未转录章节超阈值）默认开启；对话框每次打开按当前数据重置
  useEffect(() => {
    if (isOpen) setRelayEnabled(showRelay);
  }, [isOpen, showRelay]);

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-md bg-theme-bg border border-theme-border font-serif p-6 shadow-lg">
        <DialogHeader>
          <DialogTitle className="text-base font-bold text-theme-foreground tracking-tight font-serif">
            {isResubmit ? m.publish_dialog_title_resubmit() : m.publish_dialog_title()}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3.5 my-2 text-xs font-sans">
          <p className="text-theme-foreground leading-relaxed">
            {m.publish_dialog_desc({ title: repoTitle, repo: `${owner}/${repo}` })}
          </p>

          {isResubmit && rejectionReason && (
            <Alert variant="warning">
              <AlertDescription className="text-theme-muted leading-relaxed font-sans text-xs">
                <span className="font-bold">{m.publish_dialog_rejection_reason()}</span>{rejectionReason}
                <br />{m.publish_dialog_rejection_hint()}
              </AlertDescription>
            </Alert>
          )}

          {showRelay && (
            <label className="flex items-start gap-2.5 p-3 rounded-lg border border-theme-primary/30 bg-theme-primary/[0.05] cursor-pointer">
              <input
                type="checkbox"
                checked={relayEnabled}
                onChange={(e) => setRelayEnabled(e.target.checked)}
                className="mt-0.5 cursor-pointer"
              />
              <span className="text-theme-foreground leading-relaxed">
                <span className="font-bold">{m.publish_dialog_relay_title()}</span>
                <span className="text-theme-muted">{m.publish_dialog_relay_desc({ count: unprocessedCount })}</span>
              </span>
            </label>
          )}

          <Alert variant="warning">
            <AlertDescription className="text-theme-muted leading-relaxed font-sans text-xs">
              {m.publish_dialog_security_note()}
            </AlertDescription>
          </Alert>
        </div>

        <div className="flex items-center justify-end gap-2 pt-4 border-t border-theme-border/40 font-sans text-xs">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded border border-theme-border text-theme-muted hover:text-theme-foreground hover:border-theme-foreground transition-colors cursor-pointer"
          >
            {m.common_cancel()}
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onConfirm(showRelay ? { relayEnabled } : undefined);
            }}
            className="px-4 py-2 rounded bg-theme-primary text-theme-primary-fg font-serif font-bold hover:opacity-90 transition-opacity cursor-pointer shadow-xs"
          >
            {isResubmit ? m.reader_resubmit() : m.publish_dialog_confirm()}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
