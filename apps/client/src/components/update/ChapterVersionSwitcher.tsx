'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  ChevronDown,
  GitBranch,
  Loader2,
  Pin,
  Sparkles,
  ThumbsUp,
  Trash2,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Popover, PopoverTrigger, PopoverPopup } from '@/components/ui/popover';
import { toastManager } from '@/components/ui/toast';
import { requireApiKey } from '@/lib/api-key-guard';
import { api } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import * as m from '@/paraglide/messages';
export { ChapterFeedbackCard } from './ChapterFeedbackCard';

export interface VersionItem {
  id: string;
  authorId: string;
  authorName: string | null;
  authorImage: string | null;
  voteCount: number;
  isCanonical: boolean;
  visibility: 'PUBLIC' | 'PRIVATE';
  source: 'RELAY' | 'RETRANSLATE' | 'AUDIT';
  createdAt: string;
  viewerVoted: boolean;
  isCorrupted?: boolean;
}

interface ChapterVersionSwitcherProps {
  documentId: string;
  versions: VersionItem[];
  activeVersionId: string | null;
  viewerId: string | null;
  isMaintainer?: boolean;
}

const NEW_VERSION_MS = 7 * 24 * 3600_000;

function prefKey(documentId: string): string {
  return `opengits-version-pref:${documentId}`;
}

export function ChapterVersionSwitcher({
  documentId,
  versions,
  activeVersionId,
  viewerId,
  isMaintainer = false,
}: ChapterVersionSwitcherProps) {
  const router = useRouter();
  const [items, setItems] = useState(versions);
  const [busy, setBusy] = useState<string | null>(null);
  const [retranslating, setRetranslating] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);

  useEffect(() => setItems(versions), [versions]);

  useEffect(() => {
    if (typeof window === 'undefined' || activeVersionId) return;
    try {
      const pref = localStorage.getItem(prefKey(documentId));
      if (pref && pref !== 'canonical' && items.some((v) => v.id === pref)) {
        const url = new URL(window.location.href);
        url.searchParams.set('v', pref);
        window.history.replaceState(null, '', url.toString());
        router.refresh();
      }
    } catch {
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  const selectVersion = (versionId: string | 'canonical') => {
    if (versionId !== 'canonical') {
      const target = items.find((v) => v.id === versionId);
      if (target?.isCorrupted) {
        toastManager.add({
          type: 'warning',
          title: m.toast_action_failed(),
          description: m.version_corrupted_fallback(),
        });
        return;
      }
    }
    try {
      localStorage.setItem(prefKey(documentId), versionId);
    } catch {
    }
    const url = new URL(window.location.href);
    url.searchParams.set('v', versionId === 'canonical' ? 'canonical' : versionId);
    window.history.pushState(null, '', url.toString());
    setPopoverOpen(false);
    router.refresh();
  };

  const vote = async (versionId: string) => {
    if (!viewerId) {
      toastManager.add({
        type: 'warning',
        title: m.toast_login_required(),
        description: m.toast_login_required_desc(),
      });
      return;
    }
    setBusy(`vote:${versionId}`);
    try {
      const data = await api.post<{ voteCount: number; voted: boolean; canonicalChanged?: boolean }>(
        `/api/chapter-versions/${versionId}/vote`,
        undefined,
        { onUnauthorized: 'throw' }
      );
      setItems((prev) =>
        prev.map((v) => (v.id === versionId ? { ...v, voteCount: data.voteCount, viewerVoted: data.voted } : v))
      );
      if (data.canonicalChanged) {
        toastManager.add({
          type: 'success',
          title: m.chapter_version_updated_title(),
          description: m.chapter_version_updated_desc(),
        });
        router.refresh();
      }
    } catch (err) {
      toastManager.add({
        type: 'warning',
        title: m.toast_action_failed(),
        description: err instanceof Error ? err.message : '',
      });
    } finally {
      setBusy(null);
    }
  };

  const publish = async (versionId: string) => {
    setBusy(`publish:${versionId}`);
    try {
      await api.patch(`/api/chapter-versions/${versionId}`, undefined, { onUnauthorized: 'throw' });
      toastManager.add({
        type: 'success',
        title: m.chapter_publish_success_title(),
        description: m.chapter_publish_success_desc(),
      });
      router.refresh();
    } catch (err) {
      toastManager.add({
        type: 'warning',
        title: m.toast_action_failed(),
        description: err instanceof Error ? err.message : '',
      });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (versionId: string) => {
    setBusy(`delete:${versionId}`);
    try {
      await api.delete(`/api/chapter-versions/${versionId}`, { onUnauthorized: 'throw' });
      setItems((prev) => prev.filter((v) => v.id !== versionId));
      if (activeVersionId === versionId) selectVersion('canonical');
    } catch (err) {
      toastManager.add({
        type: 'warning',
        title: m.common_delete_failed(),
        description: err instanceof Error ? err.message : '',
      });
    } finally {
      setBusy(null);
    }
  };

  const pin = async (versionId: string) => {
    setBusy(`pin:${versionId}`);
    try {
      await api.post(`/api/chapter-versions/${versionId}/pin`, undefined, { onUnauthorized: 'throw' });
      toastManager.add({
        type: 'success',
        title: m.version_pinned_success(),
      });
      router.refresh();
    } catch (err) {
      toastManager.add({
        type: 'warning',
        title: m.toast_action_failed(),
        description: err instanceof Error ? err.message : '',
      });
    } finally {
      setBusy(null);
    }
  };

  const retranslate = async () => {
    setRetranslating(true);
    try {
      const data = await api.post<{ versionId: string }>('/api/chapter-versions', { documentId }, {
        onUnauthorized: 'throw',
      });
      toastManager.add({
        type: 'success',
        title: m.chapter_retranslate_success_title(),
        description: m.chapter_retranslate_success_desc(),
      });
      setConfirmOpen(false);
      setPopoverOpen(false);
      selectVersion(data.versionId);
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

  if (items.length === 0) return null;

  const visibleItems = items.filter((v) => v.visibility === 'PUBLIC' || v.authorId === viewerId);
  const activeItem =
    activeVersionId === null
      ? items.find((v) => v.isCanonical) || items[0]
      : items.find((v) => v.id === activeVersionId) || items.find((v) => v.isCanonical) || items[0];

  const isCurrentCanonical = activeVersionId === null || activeItem?.isCanonical;

  return (
    <div className="my-2.5 flex flex-wrap items-center gap-2 text-xs">
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-theme-border/70 bg-theme-surface/70 hover:bg-theme-surface text-xs font-medium text-theme-foreground transition-all cursor-pointer shadow-2xs group">
          <GitBranch className="w-3.5 h-3.5 text-theme-primary shrink-0" />
          <span className="text-theme-muted">{m.version_label()}</span>
          <span className="font-bold truncate max-w-[140px]">
            {isCurrentCanonical ? m.version_badge_canonical() : `@${activeItem?.authorName || m.version_badge_candidate()}`}
          </span>
          {visibleItems.length > 1 && (
            <span className="text-micro font-mono px-1.5 py-0.2 rounded-full bg-theme-primary/10 text-theme-primary font-bold">
              {visibleItems.length}
            </span>
          )}
          <ChevronDown className="w-3 h-3 text-theme-muted group-hover:text-theme-foreground transition-transform" />
        </PopoverTrigger>

        <PopoverPopup
          side="bottom"
          align="start"
          className="w-72 p-2 rounded-xl bg-theme-surface border border-theme-border/80 shadow-lg z-50 space-y-1.5"
        >
          <div className="px-2 py-1 text-micro font-mono text-theme-muted flex items-center justify-between border-b border-theme-border/40 pb-1.5">
            <span>{m.version_available_count({ count: visibleItems.length })}</span>
          </div>

          <div className="max-h-60 overflow-y-auto space-y-1 pr-0.5">
            {items.some((v) => v.isCanonical) && (
              <button
                type="button"
                onClick={() => selectVersion('canonical')}
                className={cn(
                  'w-full px-2.5 py-1.5 rounded-lg flex items-center justify-between text-left text-xs transition-colors cursor-pointer',
                  activeVersionId === null
                    ? 'bg-theme-primary/10 text-theme-primary font-bold'
                    : 'hover:bg-theme-bg text-theme-foreground'
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                    {activeVersionId === null && <Check className="w-3.5 h-3.5 text-theme-primary" />}
                  </span>
                  <span className="truncate">{m.version_canonical_title()}</span>
                </div>
                <span className="text-micro font-mono text-theme-muted">{m.version_default_badge()}</span>
              </button>
            )}

            {visibleItems.map((v) => {
              const active = activeVersionId === v.id;
              const isMine = v.authorId === viewerId;
              const isCorrupted = Boolean(v.isCorrupted);

              return (
                <div
                  key={v.id}
                  className={cn(
                    'px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 text-xs transition-colors',
                    active
                      ? 'bg-theme-primary/10 text-theme-primary font-bold'
                      : 'hover:bg-theme-bg text-theme-foreground'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => selectVersion(v.id)}
                    disabled={isCorrupted}
                    className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer disabled:cursor-not-allowed"
                  >
                    <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                      {active && <Check className="w-3.5 h-3.5 text-theme-primary" />}
                    </span>
                    <Avatar className="w-4 h-4 border border-theme-border/60 shrink-0">
                      <AvatarImage src={v.authorImage ?? ''} alt={v.authorName ?? ''} />
                      <AvatarFallback className="text-micro font-sans bg-theme-bg">
                        {(v.authorName ?? '?').slice(0, 1).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="truncate font-medium">{v.authorName || m.version_anonymous()}</span>
                    {v.isCanonical && (
                      <span className="px-1 py-0.2 rounded bg-theme-primary/10 text-theme-primary text-micro font-bold shrink-0">
                        {m.version_badge_canonical()}
                      </span>
                    )}
                    {v.visibility === 'PRIVATE' && (
                      <span className="px-1 py-0.2 rounded bg-theme-surface border border-theme-border text-theme-muted text-micro shrink-0">
                        {m.version_private_badge()}
                      </span>
                    )}
                  </button>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {v.visibility === 'PUBLIC' && (
                      <button
                        type="button"
                        onClick={() => vote(v.id)}
                        disabled={busy === `vote:${v.id}`}
                        className={cn(
                          'inline-flex items-center gap-1 font-mono text-micro px-1 py-0.5 rounded cursor-pointer',
                          v.viewerVoted ? 'text-theme-primary font-bold' : 'text-theme-muted hover:text-theme-foreground'
                        )}
                      >
                        <ThumbsUp className="w-3 h-3" />
                        <span>{v.voteCount}</span>
                      </button>
                    )}

                    {isMaintainer && !v.isCanonical && v.visibility === 'PUBLIC' && (
                      <button
                        type="button"
                        onClick={() => pin(v.id)}
                        disabled={busy === `pin:${v.id}`}
                        className="text-theme-muted hover:text-theme-primary cursor-pointer p-0.5"
                        title={m.version_pin_title()}
                      >
                        <Pin className="w-3 h-3" />
                      </button>
                    )}

                    {isMine && v.visibility === 'PRIVATE' && (
                      <button
                        type="button"
                        onClick={() => remove(v.id)}
                        disabled={busy === `delete:${v.id}`}
                        className="text-theme-muted hover:text-red-500 cursor-pointer p-0.5"
                        title={m.version_delete_draft()}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {viewerId && (
            <div className="pt-1.5 border-t border-theme-border/40">
              {confirmOpen ? (
                <div className="flex items-center justify-between gap-2 px-2 py-1">
                  <span className="text-micro text-theme-muted">{m.version_retranslate_confirm()}</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => requireApiKey(() => void retranslate(), m.common_retry())}
                      disabled={retranslating}
                      className="px-2 py-0.5 rounded-md bg-theme-primary text-theme-primary-fg hover:opacity-90 transition-opacity text-micro font-bold cursor-pointer disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      {retranslating ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                      <span>{retranslating ? m.version_generating() : m.common_confirm()}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmOpen(false)}
                      className="px-1.5 py-0.5 rounded-md text-theme-muted hover:text-theme-foreground text-micro cursor-pointer"
                    >
                      {m.common_cancel()}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmOpen(true)}
                  className="w-full px-2.5 py-1.5 rounded-lg hover:bg-theme-bg text-theme-primary text-xs font-medium transition-colors cursor-pointer flex items-center gap-2"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{m.version_new_with_my_model()}</span>
                </button>
              )}
            </div>
          )}
        </PopoverPopup>
      </Popover>

      {activeItem && viewerId && activeItem.authorId !== viewerId && activeItem.visibility === 'PUBLIC' && (
        <button
          type="button"
          onClick={() => vote(activeItem.id)}
          disabled={busy === `vote:${activeItem.id}`}
          className={cn(
            'inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-xs transition-colors cursor-pointer shadow-2xs',
            activeItem.viewerVoted
              ? 'border-theme-primary/40 bg-theme-primary/10 text-theme-primary font-bold'
              : 'border-theme-border/70 bg-theme-surface/70 text-theme-muted hover:text-theme-foreground'
          )}
          title={activeItem.viewerVoted ? m.version_upvoted() : m.version_upvote()}
        >
          <ThumbsUp className="w-3 h-3" />
          <span className="font-mono text-micro">{activeItem.voteCount}</span>
        </button>
      )}
    </div>
  );
}
