'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Sparkles } from 'lucide-react';
import { toastManager } from '@/components/ui/toast';
import { requireAiCapability } from '@/lib/permissions/permission-gateway';
import { api } from '@/lib/api/client';
import * as m from '@/paraglide/messages';

interface ChapterFeedbackCardProps {
  documentId: string;
  viewerId: string | null;
  isPublic?: boolean;
}

export function ChapterFeedbackCard({
  documentId,
  viewerId,
  isPublic = false,
}: ChapterFeedbackCardProps) {
  const router = useRouter();
  const [retranslating, setRetranslating] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // 仅在公开教程（支持接力竞争市场）中展示
  if (!isPublic) return null;

  const handleRetranslate = async () => {
    setRetranslating(true);
    setConfirmOpen(false);
    try {
      const data = await api.post<{ versionId: string }>('/api/chapter-versions', { documentId });
      toastManager.add({
        type: 'success',
        title: m.chapter_retranslate_success_title(),
        description: m.chapter_retranslate_success_desc(),
      });
      const url = new URL(window.location.href);
      url.searchParams.set('v', data.versionId);
      window.history.pushState(null, '', url.toString());
      router.refresh();
    } catch (err) {
      toastManager.add({
        type: 'warning',
        title: m.toast_action_failed(),
        description: err instanceof Error ? err.message : '',
      });
    } finally {
      setRetranslating(false);
    }
  };

  return (
    <div className="mt-8 p-4 rounded-xl border border-theme-border/60 bg-theme-surface/40 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs font-sans">
      <div className="flex items-center gap-2 text-theme-muted min-w-0">
        <Sparkles className="w-4 h-4 text-theme-primary shrink-0" />
        <span className="leading-relaxed">
          {m.chapter_feedback_prompt()}
        </span>
      </div>

      <div className="shrink-0 flex items-center gap-2">
        {confirmOpen ? (
          <div className="inline-flex items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                requireAiCapability(() => void handleRetranslate(), m.apikey_continue_retranslate())
              }
              disabled={retranslating}
              className="px-3 py-1 rounded-lg bg-theme-primary text-theme-primary-fg text-xs font-medium cursor-pointer disabled:opacity-50 inline-flex items-center gap-1 shadow-2xs hover:bg-theme-primary/90 transition-colors"
            >
              {retranslating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {retranslating ? m.chapter_feedback_retranslating() : m.common_confirm()}
            </button>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="px-2.5 py-1 rounded-lg border border-theme-border text-theme-muted hover:text-theme-foreground text-xs cursor-pointer transition-colors"
            >
              {m.common_cancel()}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              requireAiCapability(() => setConfirmOpen(true));
            }}
            disabled={retranslating}
            className="px-3 py-1 rounded-lg border border-theme-primary/30 bg-theme-primary/10 text-theme-primary text-xs font-medium hover:bg-theme-primary/20 transition-all cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {m.chapter_feedback_action()}
          </button>
        )}
      </div>
    </div>
  );
}
