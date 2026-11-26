'use client';
import * as m from '@/paraglide/messages';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Bell,
  CheckCheck,
  ChevronLeft,
  X,
  ExternalLink,
  Gift,
  Award,
  GitMerge,
  FileText,
  Trophy,
  RefreshCw,
  Sparkles,
  BookOpen,
  Globe,
  Trash2,
  AlertCircle,
  XCircle,
} from 'lucide-react';
import { Popover, PopoverTrigger, PopoverPopup } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/format';
import { api } from '@/lib/api/client';
import { ignoreBestEffort } from '@/lib/best-effort';
import { useSafeSession } from '@/lib/useSafeSession';
import type { NotificationItem } from '@/lib/schemas/notification';
import { useNotificationStream } from './useNotificationStream';

export interface NotificationPayload {
  owner?: string;
  repo?: string;
  path?: string;
  amount?: number;
  jobId?: string;
  reason?: string;
  error?: string;
  [key: string]: unknown;
}

export function notificationHref(item: NotificationItem): string | null {
  const payload = item.payload as NotificationPayload | null;
  if (!payload?.owner || !payload?.repo) return null;

  if (item.type === 'tutorial_published') {
    const qParam = encodeURIComponent(payload.repo);
    const highlightParam = encodeURIComponent(`${payload.owner}/${payload.repo}`);
    return `/?q=${qParam}&highlight=${highlightParam}`;
  }

  const rawPath = (payload.path || payload.docPath) as string | undefined;
  if (rawPath && typeof rawPath === 'string' && rawPath.trim()) {
    const cleanPath = rawPath.replace(/^\/+/, '');
    const slug = cleanPath.replace(/\.(md|mdx|markdown)$/i, '');
    if (slug) {
      return `/docs/${payload.owner}/${payload.repo}/${slug}`;
    }
  }
  return `/docs/${payload.owner}/${payload.repo}`;
}

export function getNotificationMeta(type: string): { label: string; icon: React.ReactNode } {
  switch (type) {
    case 'tutorial_published':
      return {
        label: m.notification_type_tutorial_published(),
        icon: <Globe className="w-3.5 h-3.5 text-theme-primary" />,
      };
    case 'publish_gift':
      return {
        label: m.notification_type_publish_gift(),
        icon: <Gift className="w-3.5 h-3.5 text-theme-primary" />,
      };
    case 'transcription_reward':
      return {
        label: m.notification_type_transcription_reward(),
        icon: <Award className="w-3.5 h-3.5 text-theme-primary" />,
      };
    case 'relay_open':
      return {
        label: m.notification_type_relay_open(),
        icon: <GitMerge className="w-3.5 h-3.5 text-theme-primary" />,
      };
    case 'chapter_trial_open':
      return {
        label: m.notification_type_chapter_trial_open(),
        icon: <FileText className="w-3.5 h-3.5 text-theme-primary" />,
      };
    case 'version_won':
      return {
        label: m.notification_type_version_won(),
        icon: <Trophy className="w-3.5 h-3.5 text-theme-primary" />,
      };
    case 'version_displaced':
      return {
        label: m.notification_type_version_displaced(),
        icon: <RefreshCw className="w-3.5 h-3.5 text-theme-muted" />,
      };
    case 'auto_sync_applied':
      return {
        label: m.auto_sync_label(),
        icon: <Sparkles className="w-3.5 h-3.5 text-theme-primary" />,
      };
    case 'transcription_done':
    case 'tutorial_transcription_done':
      return {
        label: m.notification_type_tutorial_transcription_done(),
        icon: <BookOpen className="w-3.5 h-3.5 text-theme-primary" />,
      };
    case 'transcription_failed':
      return {
        label: m.notification_type_transcription_failed(),
        icon: <AlertCircle className="w-3.5 h-3.5 text-destructive" />,
      };
    case 'tutorial_rejected':
      return {
        label: m.notification_type_tutorial_rejected(),
        icon: <XCircle className="w-3.5 h-3.5 text-destructive" />,
      };
    default:
      return {
        label: m.notifications_title(),
        icon: <Bell className="w-3.5 h-3.5 text-theme-muted" />,
      };
  }
}

interface NotificationListEnvelope {
  items: NotificationItem[];
  unreadCount: number;
}

export function NotificationBell({ className }: { className?: string }) {
  const { data: session } = useSafeSession();
  const router = useRouter();
  const [unreadCount, setUnreadCount] = useState(0);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [activeItem, setActiveItem] = useState<NotificationItem | null>(null);
  const [open, setOpen] = useState(false);

  const isLoggedIn = Boolean(session?.user?.id);

  const fetchUnread = useCallback(async () => {
    if (!isLoggedIn) return;
    try {
      const data = await api.get<Partial<NotificationListEnvelope>>('/api/notifications?pageSize=1', {
        onUnauthorized: 'throw',
      });
      setUnreadCount(data.unreadCount ?? 0);
    } catch {
      ignoreBestEffort();
    }
  }, [isLoggedIn]);

  const fetchList = useCallback(async () => {
    if (!isLoggedIn) return;
    try {
      const data = await api.get<Partial<NotificationListEnvelope>>('/api/notifications?pageSize=15', {
        onUnauthorized: 'throw',
      });
      setItems(data.items ?? []);
      setUnreadCount(data.unreadCount ?? 0);
    } catch (err) {
      console.warn('[notification-bell] fetch failed:', err);
      setItems([]);
    }
  }, [isLoggedIn]);

  const handleStreamSnapshot = useCallback((count: number) => {
    setUnreadCount(count);
  }, []);

  useNotificationStream(isLoggedIn, handleStreamSnapshot, fetchUnread);

  if (!isLoggedIn) {
    return null;
  }

  const markRead = (payload: { all?: boolean; ids?: string[] }) => {
    return api.patch('/api/notifications/read', payload, { onUnauthorized: 'throw' }).catch(() => undefined);
  };

  const markAllRead = async () => {
    await markRead({ all: true });
    setUnreadCount(0);
    setItems((prev) => prev?.map((i) => ({ ...i, readAt: i.readAt ?? new Date() })) ?? null);
    if (activeItem) {
      setActiveItem((prev) => (prev ? { ...prev, readAt: prev.readAt ?? new Date() } : null));
    }
  };

  const clearAll = async () => {
    await api.delete('/api/notifications', { onUnauthorized: 'throw' }).catch(() => undefined);
    setUnreadCount(0);
    setItems([]);
    setActiveItem(null);
  };

  const onItemClick = (item: NotificationItem) => {
    const updated = item.readAt ? item : { ...item, readAt: new Date() };
    if (!item.readAt) {
      void markRead({ ids: [item.id] });
      setUnreadCount((c) => Math.max(0, c - 1));
      setItems((prev) => prev?.map((i) => (i.id === item.id ? updated : i)) ?? null);
    }
    setActiveItem((prev) => (prev?.id === item.id ? null : updated));
  };

  const activeHref = activeItem ? notificationHref(activeItem) : null;
  const activeMeta = activeItem ? getNotificationMeta(activeItem.type) : null;
  const activePayload = activeItem?.payload as NotificationPayload | null;
  const hasUnreadWarning = Boolean(
    items?.some(
      (item) => !item.readAt && (item.type === 'transcription_failed' || item.type === 'tutorial_rejected')
    )
  );

  const renderPayloadDetails = (payload: NotificationPayload | null) => {
    if (!payload || typeof payload !== 'object') return null;
    const hasRepo = Boolean(payload.owner && payload.repo);
    const hasPath = Boolean(payload.path);
    const hasAmount = typeof payload.amount === 'number';
    const hasReason = Boolean(payload.reason || payload.error);

    if (!hasRepo && !hasPath && !hasAmount && !hasReason) return null;

    return (
      <div className="flex flex-col gap-1.5 pt-1">
        {hasRepo && (
          <div className="flex items-center gap-1.5 text-caption text-theme-muted bg-theme-bg/60 px-2 py-1 rounded-lg border border-theme-border/40">
            <BookOpen className="w-3 h-3 text-theme-primary shrink-0" />
            <span className="truncate font-mono">{payload.owner}/{payload.repo}</span>
          </div>
        )}
        {hasPath && (
          <div className="flex items-center gap-1.5 text-caption text-theme-muted bg-theme-bg/60 px-2 py-1 rounded-lg border border-theme-border/40">
            <FileText className="w-3 h-3 text-theme-muted shrink-0" />
            <span className="truncate font-mono">{payload.path}</span>
          </div>
        )}
        {hasAmount && (
          <div className="flex items-center gap-1.5 text-caption text-theme-foreground bg-theme-primary/[0.08] px-2 py-1 rounded-lg border border-theme-primary/20">
            <Award className="w-3 h-3 text-theme-primary shrink-0" />
            <span className="font-semibold text-theme-primary">{m.notification_points_amount({ amount: payload.amount ?? 0 })}</span>
          </div>
        )}
        {hasReason && (
          <div className="flex items-start gap-1.5 text-caption text-destructive bg-destructive/10 px-2 py-1 rounded-lg border border-destructive/20">
            <AlertCircle className="w-3 h-3 text-destructive shrink-0 mt-0.5" />
            <span className="break-all">{String(payload.reason || payload.error)}</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next === true);
        if (next) {
          fetchList();
        } else {
          setActiveItem(null);
        }
      }}
    >
      <PopoverTrigger
        className={cn(
          'group relative flex items-center justify-center size-8 rounded-lg hover:bg-theme-surface text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer select-none shadow-none',
          className
        )}
        aria-label={m.notifications_title()}
        title={m.notifications_title()}
      >
        <Bell className="w-4 h-4 group-hover:scale-105 transition-transform shrink-0" />
        {unreadCount > 0 && (
          <span
            className={cn(
              'absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full ring-2 ring-theme-bg',
              hasUnreadWarning ? 'bg-destructive ring-destructive/20' : 'bg-theme-primary'
            )}
          />
        )}
      </PopoverTrigger>

      <PopoverPopup
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-[300px] sm:w-[320px] !p-0 rounded-2xl bg-theme-surface border border-theme-border shadow-xl backdrop-blur-xl text-theme-foreground font-sans z-50 !overflow-visible"
        viewportClassName="!p-0 !overflow-visible relative"
      >
        {activeItem && activeMeta && (
          <div className="hidden md:flex flex-col absolute right-[calc(100%+12px)] top-0 w-[290px] rounded-2xl bg-theme-surface border border-theme-border shadow-2xl backdrop-blur-xl text-theme-foreground overflow-hidden animate-in fade-in slide-in-from-right-2 duration-150 z-50">
            <div className="px-3.5 py-2.5 flex items-center justify-between border-b border-theme-border/40">
              <span className="text-xs font-bold text-theme-foreground flex items-center gap-1.5">
                {activeMeta.icon}
                <span>{activeMeta.label}</span>
              </span>
              <button
                type="button"
                onClick={() => setActiveItem(null)}
                className="p-1 rounded-lg text-theme-muted hover:text-theme-foreground hover:bg-theme-bg/60 transition-colors cursor-pointer"
                title={m.common_close()}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="p-3.5 flex flex-col gap-2.5 max-h-[300px] overflow-y-auto">
              <div>
                <h4 className="text-xs font-semibold text-theme-foreground leading-snug break-words">
                  {activeItem.title}
                </h4>
                {activeItem.body && (
                  <p className="text-caption text-theme-muted leading-relaxed mt-1.5 whitespace-pre-wrap break-words">
                    {activeItem.body}
                  </p>
                )}
              </div>

              {renderPayloadDetails(activePayload)}

              <div className="pt-2 border-t border-theme-border/30 flex items-center justify-between text-compact text-theme-muted/70 font-mono">
                <span>{formatRelativeTime(activeItem.createdAt)}</span>
                <span
                  className={cn(
                    'px-1.5 py-0.5 rounded text-caption font-sans',
                    activeItem.readAt
                      ? 'text-theme-muted bg-theme-bg'
                      : activeItem.type === 'transcription_failed' || activeItem.type === 'tutorial_rejected'
                      ? 'text-destructive bg-destructive/10 font-semibold'
                      : 'text-theme-primary bg-theme-primary/10 font-semibold'
                  )}
                >
                  {activeItem.readAt ? m.notifications_status_read() : m.notifications_status_unread()}
                </span>
              </div>
            </div>

            {activeHref && (
              <div className="p-2.5 border-t border-theme-border/40 bg-theme-surface/60">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setActiveItem(null);
                    router.push(activeHref);
                  }}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl bg-theme-primary text-theme-primary-foreground hover:bg-theme-primary/90 text-xs font-medium transition-colors cursor-pointer"
                >
                  <span>{m.notifications_view_target()}</span>
                  <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                </button>
              </div>
            )}
          </div>
        )}

        <div className="w-full rounded-2xl overflow-hidden flex flex-col">
          {activeItem && activeMeta ? (
            <div className="flex md:hidden flex-col">
              <div className="px-3.5 py-2.5 flex items-center justify-between border-b border-theme-border/40">
                <button
                  type="button"
                  onClick={() => setActiveItem(null)}
                  className="inline-flex items-center gap-1 text-xs text-theme-muted hover:text-theme-foreground cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>{m.common_back()}</span>
                </button>
                <span className="text-xs font-semibold text-theme-foreground flex items-center gap-1">
                  {activeMeta.icon}
                  <span>{activeMeta.label}</span>
                </span>
              </div>

              <div className="p-3.5 flex flex-col gap-2.5 max-h-[300px] overflow-y-auto">
                <div>
                  <h4 className="text-xs font-semibold text-theme-foreground leading-snug break-words">
                    {activeItem.title}
                  </h4>
                  {activeItem.body && (
                    <p className="text-caption text-theme-muted leading-relaxed mt-1.5 whitespace-pre-wrap break-words">
                      {activeItem.body}
                    </p>
                  )}
                </div>

                {renderPayloadDetails(activePayload)}

                <div className="pt-2 border-t border-theme-border/30 flex items-center justify-between text-compact text-theme-muted/70 font-mono">
                  <span>{formatRelativeTime(activeItem.createdAt)}</span>
                </div>
              </div>

              {activeHref && (
                <div className="p-2.5 border-t border-theme-border/40 bg-theme-surface/60">
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      setActiveItem(null);
                      router.push(activeHref);
                    }}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl bg-theme-primary text-theme-primary-foreground hover:bg-theme-primary/90 text-xs font-medium transition-colors cursor-pointer"
                  >
                    <span>{m.notifications_view_target()}</span>
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                  </button>
                </div>
              )}
            </div>
          ) : null}

          <div className={cn('flex flex-col', activeItem && 'max-md:hidden')}>
            <div className="px-3.5 py-2.5 flex items-center justify-between border-b border-theme-border/40">
              <span className="text-xs font-bold text-theme-foreground">{m.notifications_title()}</span>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={markAllRead}
                    className="inline-flex items-center gap-1 text-compact text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer"
                  >
                    <CheckCheck className="w-3 h-3" />
                    {m.notifications_mark_all_read()}
                  </button>
                )}
                {items && items.length > 0 && (
                  <button
                    type="button"
                    onClick={clearAll}
                    className="inline-flex items-center gap-1 text-compact text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer"
                    title={m.notifications_clear()}
                  >
                    <Trash2 className="w-3 h-3" />
                    {m.notifications_clear()}
                  </button>
                )}
              </div>
            </div>

            <div className="max-h-[320px] overflow-y-auto">
              {items === null && <div className="py-6 text-center text-xs text-theme-muted">{m.common_loading()}</div>}
              {items !== null && items.length === 0 && (
                <div className="py-6 text-center text-xs text-theme-muted">{m.notifications_empty()}</div>
              )}
              {items?.map((item) => {
                const isActive = activeItem?.id === item.id;
                const isWarning = item.type === 'transcription_failed' || item.type === 'tutorial_rejected';
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onItemClick(item)}
                    className={cn(
                      'w-full text-left px-3.5 py-2.5 flex items-start gap-2.5 border-b border-theme-border/30 last:border-b-0 hover:bg-theme-bg/60 transition-colors cursor-pointer',
                      !item.readAt && (isWarning ? 'bg-destructive/[0.04]' : 'bg-theme-primary/[0.04]'),
                      isActive && 'bg-theme-bg/90 ring-1 ring-inset ring-theme-primary/30'
                    )}
                  >
                    <span
                      className={cn(
                        'w-1.5 h-1.5 rounded-full mt-1.5 shrink-0',
                        item.readAt
                          ? 'bg-transparent border border-theme-border'
                          : isWarning
                          ? 'bg-destructive ring-2 ring-destructive/20'
                          : 'bg-theme-primary'
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className={cn('block text-xs font-semibold truncate', isWarning && !item.readAt ? 'text-destructive' : 'text-theme-foreground')}>
                          {item.title}
                        </span>
                        {isWarning && (
                          <span className="shrink-0 px-1 py-0.5 text-micro font-medium rounded bg-destructive/10 text-destructive border border-destructive/20">
                            {item.type === 'transcription_failed' ? m.notification_type_transcription_failed() : m.notification_type_tutorial_rejected()}
                          </span>
                        )}
                      </div>
                      {item.body && (
                        <span className="block text-caption text-theme-muted leading-snug line-clamp-2 mt-0.5">
                          {item.body}
                        </span>
                      )}
                      <span className="block text-compact text-theme-muted/70 font-mono mt-1">
                        {formatRelativeTime(item.createdAt)}
                      </span>
                    </span>
                    {isActive && (
                      <span className="hidden md:flex items-center self-center text-theme-primary shrink-0">
                        <ChevronLeft className="w-3.5 h-3.5" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
