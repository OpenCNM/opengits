'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import {
  Globe,
  BookOpen,
  Compass,
  Search,
  RefreshCw,
  AlertTriangle,
  Sparkles,
  GitBranch,
  Layers,
  Users,
  Clock,
  Undo2,
  EyeOff,
  Trash2,
} from 'lucide-react';
import * as m from '@/paraglide/messages';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api/client';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PublishConfirmDialog } from '@/components/publish/PublishConfirmDialog';
import { PublishProgressModal } from '@/components/publish/PublishProgressModal';
import { RelayAvatarStack } from '@/components/update/RelayAvatarStack';
import { toastManager } from '@/components/ui/toast';
import { Skeleton } from '@/components/ui/skeleton';
import { PUBLICATIONS_PAGINATION } from '@/lib/constants';
import { PublicationsPagination } from '@/components/settings/PublicationsPagination';
import type { UserPublicationItem } from '@/app/api/user/publications/route';

type PublicationFilter = 'all' | 'published' | 'pending' | 'draft' | 'rejected' | 'relay';

type PendingConfirmAction =
  | { kind: 'withdraw'; item: UserPublicationItem }
  | { kind: 'unpublish'; item: UserPublicationItem }
  | { kind: 'toggleRelay'; item: UserPublicationItem; nextRelay: boolean }
  | { kind: 'delete'; item: UserPublicationItem };

function formatTargetLabel(item: UserPublicationItem): string {
  return item.editionLabel
    ? `${item.owner}/${item.repo} (${item.editionLabel})`
    : `${item.owner}/${item.repo}`;
}

function resolveConfirmDialogContent(action: PendingConfirmAction | null) {
  if (!action) {
    return {
      title: '',
      description: undefined,
      confirmText: undefined,
      variant: 'danger' as const,
    };
  }
  const targetLabel = formatTargetLabel(action.item);
  switch (action.kind) {
    case 'withdraw':
      return {
        title: m.publications_dialog_withdraw_title(),
        description: `${targetLabel}\n${m.publications_withdraw_confirm()}`,
        confirmText: m.publications_btn_withdraw(),
        variant: 'warning' as const,
      };
    case 'unpublish':
      return {
        title: m.publications_dialog_unpublish_title(),
        description: `${targetLabel}\n${m.publications_unpublish_confirm()}`,
        confirmText: m.publications_btn_unpublish(),
        variant: 'danger' as const,
      };
    case 'toggleRelay':
      return {
        title: action.nextRelay
          ? m.publications_dialog_relay_enable_title()
          : m.publications_dialog_relay_disable_title(),
        description: `${targetLabel}\n${
          action.nextRelay
            ? m.publications_relay_toggle_confirm_enable()
            : m.publications_relay_toggle_confirm_disable()
        }`,
        confirmText: action.nextRelay
          ? m.publications_relay_btn_enable()
          : m.publications_relay_btn_disable(),
        variant: action.nextRelay ? ('primary' as const) : ('warning' as const),
      };
    case 'delete':
      return {
        title: m.publications_dialog_delete_title(),
        description: m.publications_delete_confirm({ repo: targetLabel }),
        confirmText: m.common_confirm_delete(),
        variant: 'danger' as const,
      };
  }
}

function getItemCategory(item: UserPublicationItem): 'published' | 'pending' | 'rejected' | 'draft' {
  if (item.isPublic) return 'published';
  if (item.reviewStatus === 'PENDING') return 'pending';
  if (item.reviewStatus === 'REJECTED') return 'rejected';
  return 'draft';
}

export function PublicationsManagerView() {
  const [publications, setPublications] = useState<UserPublicationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<PublicationFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const listTopRef = React.useRef<HTMLDivElement>(null);
  const [togglingRelayId, setTogglingRelayId] = useState<string | null>(null);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const [unpublishingId, setUnpublishingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingConfirmAction | null>(null);

  const [confirmRepo, setConfirmRepo] = useState<UserPublicationItem | null>(null);
  const [progressRepo, setProgressRepo] = useState<{
    owner: string;
    repo: string;
    repoId: string;
    relayEnabled: boolean;
  } | null>(null);

  const fetchPublications = useCallback(async () => {
    try {
      const data = await api.get<{ publications: UserPublicationItem[] }>(
        '/api/user/publications',
        { onUnauthorized: 'throw' }
      );
      if (Array.isArray(data?.publications)) {
        setPublications(data.publications);
      }
    } catch (err: unknown) {
      toastManager.add({
        type: 'error',
        title: m.publications_load_failed(),
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPublications();
  }, [fetchPublications]);

  const executeConfirmedAction = async (action: PendingConfirmAction) => {
    const { item } = action;
    try {
      switch (action.kind) {
        case 'toggleRelay': {
          setTogglingRelayId(item.id);
          try {
            await api.patch('/api/repos/publish', {
              repoId: item.id,
              relayEnabled: action.nextRelay,
              onlyToggleRelay: true,
            });
            toastManager.add({
              type: 'success',
              title: action.nextRelay
                ? m.publications_relay_enable_success()
                : m.publications_relay_disable_success(),
            });
            await fetchPublications();
          } finally {
            setTogglingRelayId(null);
          }
          break;
        }
        case 'withdraw': {
          setWithdrawingId(item.id);
          try {
            await api.patch('/api/repos/publish', {
              repoId: item.id,
              withdraw: true,
            });
            toastManager.add({
              type: 'success',
              title: m.publications_withdraw_success(),
            });
            await fetchPublications();
          } finally {
            setWithdrawingId(null);
          }
          break;
        }
        case 'unpublish': {
          setUnpublishingId(item.id);
          try {
            await api.post('/api/repos/unpublish', {
              repoId: item.id,
            });
            toastManager.add({
              type: 'success',
              title: m.publications_unpublish_success(),
            });
            await fetchPublications();
          } finally {
            setUnpublishingId(null);
          }
          break;
        }
        case 'delete': {
          setDeletingId(item.id);
          try {
            await api.delete(`/api/repos?id=${encodeURIComponent(item.id)}&global=true`);
            setPublications((prev) => prev.filter((p) => p.id !== item.id));
            toastManager.add({
              type: 'success',
              title: m.publications_delete_success(),
            });
            await fetchPublications();
          } finally {
            setDeletingId(null);
          }
          break;
        }
      }
    } catch (err: unknown) {
      toastManager.add({
        type: 'error',
        title: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const confirmDialogConfig = resolveConfirmDialogContent(pendingAction);

  const counts = useMemo(() => {
    const c = { all: publications.length, published: 0, pending: 0, draft: 0, rejected: 0, relay: 0 };
    for (const item of publications) {
      const cat = getItemCategory(item);
      c[cat]++;
      if (item.relayEnabled) {
        c.relay++;
      }
    }
    return c;
  }, [publications]);

  const filteredPublications = useMemo(() => {
    return publications.filter((item) => {
      if (activeFilter === 'relay') {
        if (!item.relayEnabled) return false;
      } else if (activeFilter !== 'all') {
        const category = getItemCategory(item);
        if (category !== activeFilter) return false;
      }
      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        const fullRepo = `${item.owner}/${item.repo}`.toLowerCase();
        const edition = (item.editionLabel || item.edition || '').toLowerCase();
        return fullRepo.includes(query) || edition.includes(query);
      }
      return true;
    });
  }, [publications, activeFilter, searchQuery]);

  useEffect(() => {
    setCurrentPage(1);
  }, [activeFilter, searchQuery]);

  const pageSize = PUBLICATIONS_PAGINATION.PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(filteredPublications.length / pageSize));
  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const paginatedPublications = useMemo(() => {
    const startIndex = (safeCurrentPage - 1) * pageSize;
    return filteredPublications.slice(startIndex, startIndex + pageSize);
  }, [filteredPublications, safeCurrentPage, pageSize]);

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    listTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const filterTabs: Array<{ id: PublicationFilter; label: string; count: number }> = [
    { id: 'all', label: m.publications_filter_all(), count: counts.all },
    { id: 'published', label: m.publications_filter_published(), count: counts.published },
    { id: 'pending', label: m.publications_filter_pending(), count: counts.pending },
    { id: 'draft', label: m.publications_filter_draft(), count: counts.draft },
    { id: 'rejected', label: m.publications_filter_rejected(), count: counts.rejected },
    { id: 'relay', label: m.publications_filter_relay(), count: counts.relay },
  ];

  return (
    <div ref={listTopRef} className="space-y-6">
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
        <div className="flex items-center gap-1.5 p-1 bg-theme-surface/40 border border-theme-border/60 rounded-xl overflow-x-auto">
          {filterTabs.map((tab) => {
            const isActive = activeFilter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveFilter(tab.id)}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer whitespace-nowrap flex items-center gap-1.5 select-none',
                  isActive
                    ? 'bg-theme-bg text-theme-foreground shadow-2xs border border-theme-border font-semibold'
                    : 'text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/50 border border-transparent'
                )}
              >
                <span>{tab.label}</span>
                <span
                  className={cn(
                    'px-1.5 py-0.5 rounded-full text-xs font-mono',
                    isActive ? 'bg-theme-surface text-theme-foreground' : 'text-theme-muted'
                  )}
                >
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="relative w-full sm:w-64">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-muted pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={m.publications_search_placeholder()}
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-theme-bg border border-theme-border/70 rounded-xl text-theme-foreground placeholder:text-theme-muted focus:outline-none focus:border-theme-primary transition-colors font-sans"
          />
        </div>
      </div>

      {loading ? (
        <div className="space-y-2.5">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="px-3.5 py-2.5 border border-theme-border/50 rounded-xl bg-theme-surface/20 space-y-1.5">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-44 rounded" />
                <div className="flex items-center gap-2">
                  <Skeleton className="h-4 w-14 rounded" />
                  <Skeleton className="h-4 w-16 rounded" />
                </div>
              </div>
              <div className="flex items-center justify-between pt-1 border-t border-theme-border/20">
                <Skeleton className="h-3 w-56 rounded" />
                <Skeleton className="h-3 w-20 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : publications.length === 0 ? (
        <div className="py-16 text-center border border-dashed border-theme-border/80 rounded-2xl bg-theme-surface/10 space-y-4">
          <div className="w-12 h-12 rounded-full bg-theme-surface border border-theme-border flex items-center justify-center mx-auto text-theme-muted">
            <BookOpen size={22} />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-theme-foreground">
              {m.publications_empty_title()}
            </h3>
            <p className="text-xs text-theme-muted max-w-sm mx-auto leading-relaxed">
              {m.publications_empty_desc()}
            </p>
          </div>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-theme-primary text-theme-primary-foreground hover:opacity-90 transition-opacity shadow-xs cursor-pointer select-none"
          >
            <span>{m.publications_empty_action()}</span>
          </Link>
        </div>
      ) : filteredPublications.length === 0 ? (
        <div className="py-12 text-center border border-theme-border/60 rounded-xl bg-theme-surface/10">
          <p className="text-xs text-theme-muted">{m.publications_no_matches()}</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-2.5">
            {paginatedPublications.map((item) => {
              const progressPercent = item.chapterCount > 0
                ? Math.min(100, Math.round((item.processedDocsCount / item.chapterCount) * 100))
                : 0;

              const isResubmit = item.reviewStatus === 'REJECTED';
              const isPending = item.reviewStatus === 'PENDING';
              const isPublished = item.isPublic;

              return (
                <div
                  key={item.id}
                  className="border border-theme-border/70 bg-theme-surface/30 hover:border-theme-border hover:bg-theme-surface/50 rounded-xl px-3.5 py-2.5 transition-all space-y-1.5 font-sans"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                      <Link
                        href={item.docUrl}
                        className="text-xs sm:text-sm font-semibold text-theme-foreground hover:text-theme-primary transition-colors flex items-center gap-1.5 truncate"
                      >
                        <span>{item.owner}/{item.repo}</span>
                      </Link>

                      {item.isMaintainer ? (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-micro bg-theme-primary/10 border border-theme-primary/20 text-theme-primary font-medium shrink-0">
                          {m.publications_role_maintainer()}
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-micro bg-theme-surface/60 border border-theme-border/60 text-theme-muted font-medium shrink-0">
                          {m.publications_role_contributor()}
                        </span>
                      )}

                      {item.editionLabel && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-micro bg-theme-surface border border-theme-border text-theme-foreground font-medium shrink-0">
                          <Layers size={11} className="text-theme-muted" />
                          {item.editionLabel}
                        </span>
                      )}

                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-micro bg-theme-surface/60 border border-theme-border/60 text-theme-muted font-mono shrink-0">
                        <GitBranch size={11} />
                        {item.branch}
                      </span>

                      {item.relayEnabled && (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-micro bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20 font-medium shrink-0"
                          title={item.unprocessedCount === 0 ? m.publications_relay_badge_completed() : m.publications_relay_badge_active()}
                        >
                          <Users size={11} />
                          <span>{item.unprocessedCount === 0 ? m.publications_relay_badge_completed() : m.publications_relay_badge_active()}</span>
                          {item.relayInProgressCount > 0 && (
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse ml-0.5" />
                          )}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {isPublished ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-micro font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                          {m.publications_status_published()}
                        </span>
                      ) : isPending ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-micro font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                          {m.publications_status_pending()}
                        </span>
                      ) : isResubmit ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-micro font-medium bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20">
                          <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                          {m.publications_status_rejected()}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-micro font-medium bg-theme-surface text-theme-muted border border-theme-border">
                          <span className="w-1.5 h-1.5 rounded-full bg-theme-muted" />
                          {m.publications_status_draft()}
                        </span>
                      )}

                      {item.isMaintainer && item.unprocessedCount > 0 && (
                        <button
                          type="button"
                          disabled={togglingRelayId === item.id}
                          onClick={() =>
                            setPendingAction({ kind: 'toggleRelay', item, nextRelay: !item.relayEnabled })
                          }
                          className={cn(
                            'px-2 py-0.5 rounded-md text-micro font-medium transition-colors cursor-pointer flex items-center gap-1',
                            item.relayEnabled
                              ? 'border border-theme-border/80 text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/50'
                              : 'border border-indigo-500/40 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10'
                          )}
                        >
                          <Users size={11} className={togglingRelayId === item.id ? 'animate-spin' : ''} />
                          <span>
                            {item.relayEnabled
                              ? m.publications_relay_btn_disable()
                              : m.publications_relay_btn_enable()}
                          </span>
                        </button>
                      )}

                      {isPublished ? (
                        item.isMaintainer ? (
                          <button
                            type="button"
                            disabled={unpublishingId === item.id}
                            onClick={() => setPendingAction({ kind: 'unpublish', item })}
                            className="px-2 py-0.5 rounded-md border border-theme-border/80 text-theme-muted hover:text-rose-500 hover:border-rose-500/40 hover:bg-rose-500/10 text-micro font-medium transition-colors cursor-pointer flex items-center gap-1 select-none"
                          >
                            <EyeOff size={11} className={unpublishingId === item.id ? 'animate-spin' : ''} />
                            <span>
                              {unpublishingId === item.id
                                ? m.publications_btn_unpublishing()
                                : m.publications_btn_unpublish()}
                            </span>
                          </button>
                        ) : null
                      ) : isPending ? (
                        item.isMaintainer ? (
                          <button
                            type="button"
                            disabled={withdrawingId === item.id}
                            onClick={() => setPendingAction({ kind: 'withdraw', item })}
                            className="px-2 py-0.5 rounded-md border border-theme-border/80 text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/60 text-micro font-medium transition-colors cursor-pointer flex items-center gap-1 select-none"
                          >
                            <Undo2 size={11} className={withdrawingId === item.id ? 'animate-spin' : ''} />
                            <span>
                              {withdrawingId === item.id
                                ? m.publications_btn_withdrawing()
                                : m.publications_btn_withdraw()}
                            </span>
                          </button>
                        ) : null
                      ) : !item.isMaintainer ? (
                        <button
                          type="button"
                          disabled
                          className="px-2 py-0.5 rounded-md bg-theme-surface/60 text-theme-muted border border-theme-border/60 text-micro font-medium cursor-not-allowed select-none opacity-60"
                          title={m.publications_not_maintainer_tooltip()}
                        >
                          {isResubmit ? m.publications_btn_resubmit() : m.publications_btn_publish()}
                        </button>
                      ) : (
                        <>
                          {isResubmit ? (
                            <button
                              type="button"
                              onClick={() => {
                                setConfirmRepo(item);
                              }}
                              className="px-2 py-0.5 rounded-md border border-rose-500/40 text-rose-500 hover:bg-rose-500/10 text-micro font-medium transition-colors cursor-pointer"
                            >
                              {m.publications_btn_resubmit()}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setConfirmRepo(item);
                              }}
                              className="px-2.5 py-0.5 rounded-md bg-theme-primary text-theme-primary-foreground hover:opacity-90 text-micro font-medium transition-opacity shadow-xs cursor-pointer select-none"
                            >
                              {m.publications_btn_publish()}
                            </button>
                          )}

                          <button
                            type="button"
                            disabled={deletingId === item.id || item.hasExternalUsers}
                            onClick={() => setPendingAction({ kind: 'delete', item })}
                            title={item.hasExternalUsers ? m.publications_delete_blocked_external() : undefined}
                            className={cn(
                              'px-2 py-0.5 rounded-md border text-micro font-medium transition-colors flex items-center gap-1 select-none',
                              item.hasExternalUsers
                                ? 'border-theme-border/50 text-theme-muted/50 cursor-not-allowed'
                                : 'border-theme-border/80 text-theme-muted hover:text-rose-500 hover:border-rose-500/40 hover:bg-rose-500/10 cursor-pointer'
                            )}
                          >
                            <Trash2 size={11} className={deletingId === item.id ? 'animate-pulse' : ''} />
                            <span>
                              {deletingId === item.id ? m.publications_btn_deleting() : m.publications_btn_delete()}
                            </span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {isResubmit && item.rejectionReason && (
                    <div className="px-2.5 py-1 rounded-md bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-micro flex items-center gap-1.5">
                      <AlertTriangle size={12} className="shrink-0" />
                      <span className="font-semibold">{m.publications_rejection_reason_label()}</span>
                      <span className="truncate">{item.rejectionReason}</span>
                    </div>
                  )}

                  {isPending && (
                    <div className="px-2.5 py-1 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-300 text-micro flex items-center gap-1.5">
                      <Clock size={12} className="shrink-0 text-amber-500" />
                      <span className="truncate">{m.publications_pending_banner_desc()}</span>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-micro text-theme-muted pt-1 border-t border-theme-border/30">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <div className="flex items-center gap-1.5">
                        <span>
                          {m.publications_progress_ready({
                            processed: item.processedDocsCount,
                            total: item.chapterCount,
                          })}
                        </span>
                        <div className="w-16 h-1 bg-theme-surface border border-theme-border/40 rounded-full overflow-hidden shrink-0">
                          <div
                            className={cn(
                              'h-full rounded-full transition-all duration-300',
                              isPublished ? 'bg-emerald-500' : 'bg-theme-primary'
                            )}
                            style={{ width: `${progressPercent}%` }}
                          />
                        </div>
                        <span className="font-mono">{progressPercent}%</span>
                      </div>

                      <span className="text-theme-border/80">·</span>

                      <Link
                        href={item.docUrl}
                        className="inline-flex items-center gap-1 hover:text-theme-foreground transition-colors cursor-pointer select-none"
                      >
                        <BookOpen size={11} />
                        <span>{m.publications_read_tutorial()}</span>
                      </Link>

                      {isPublished && (
                        <Link
                          href={`/explore?q=${encodeURIComponent(item.repo)}`}
                          className="inline-flex items-center gap-1 hover:text-theme-foreground transition-colors cursor-pointer select-none"
                        >
                          <Compass size={11} />
                          <span>{m.publications_explore_link()}</span>
                        </Link>
                      )}

                      {isPublished && item.transcriptionCreditsEarned > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400 font-medium">
                          <Sparkles size={11} />
                          <span>{m.publications_credits_earned({ credits: item.transcriptionCreditsEarned })}</span>
                        </span>
                      )}
                    </div>

                    {(item.relayEnabled || (item.relayParticipants && item.relayParticipants.length > 0)) && (
                      <div className="flex items-center gap-1.5">
                        {item.relayParticipants && item.relayParticipants.length > 0 && (
                          <RelayAvatarStack participants={item.relayParticipants} size="xs" />
                        )}
                        <span>
                          {item.relayInProgressCount > 0
                            ? m.relay_chapters_in_progress({ count: item.relayInProgressCount })
                            : item.relayParticipants && item.relayParticipants.length > 0
                              ? m.relay_participants_count({ count: item.relayParticipants.length })
                              : m.relay_waiting_community()}
                        </span>
                        {item.unprocessedCount > 0 && (
                          <span className="text-indigo-600 dark:text-indigo-400 font-medium">
                            ({m.publications_relay_status_waiting({ count: item.unprocessedCount })})
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

        <PublicationsPagination
          currentPage={safeCurrentPage}
          totalPages={totalPages}
          totalItems={filteredPublications.length}
          pageSize={pageSize}
          onPageChange={handlePageChange}
        />
      </div>
    )}

      {confirmRepo && (
        <PublishConfirmDialog
          isOpen={Boolean(confirmRepo)}
          onClose={() => setConfirmRepo(null)}
          onConfirm={(opts) => {
            const target = confirmRepo;
            setConfirmRepo(null);
            if (target) {
              setProgressRepo({
                owner: target.owner,
                repo: target.repo,
                repoId: target.id,
                relayEnabled: !!opts?.relayEnabled,
              });
            }
          }}
          repoTitle={confirmRepo.editionLabel ? `${confirmRepo.repo} (${confirmRepo.editionLabel})` : confirmRepo.repo}
          owner={confirmRepo.owner}
          repo={confirmRepo.repo}
          reviewStatus={confirmRepo.reviewStatus}
          rejectionReason={confirmRepo.rejectionReason}
          unprocessedCount={confirmRepo.unprocessedCount}
        />
      )}

      {progressRepo && (
        <PublishProgressModal
          isOpen={Boolean(progressRepo)}
          onClose={() => {
            setProgressRepo(null);
            fetchPublications();
          }}
          owner={progressRepo.owner}
          repo={progressRepo.repo}
          repoId={progressRepo.repoId}
          relayEnabled={progressRepo.relayEnabled}
          onSubmitted={() => {
            toastManager.add({
              type: 'info',
              title: m.publish_review_submitted_title(),
              description: m.publish_review_submitted_desc(),
            });
            fetchPublications();
          }}
          onSuccess={() => {
            toastManager.add({
              type: 'success',
              title: m.toast_publish_success(),
              description: m.publish_success_desc(),
            });
            fetchPublications();
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(pendingAction)}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
        title={confirmDialogConfig.title}
        description={confirmDialogConfig.description}
        confirmText={confirmDialogConfig.confirmText}
        cancelText={m.common_cancel()}
        variant={confirmDialogConfig.variant}
        onConfirm={() => {
          const action = pendingAction;
          if (action) {
            void executeConfirmedAction(action);
          }
        }}
      />
    </div>
  );
}
