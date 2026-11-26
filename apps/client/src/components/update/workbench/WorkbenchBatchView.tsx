import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import { docPathToSlug } from '@/lib/outline-reader';
import {
  ArrowUpCircle,
  BookOpen,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Lock,
  Sparkles,
  Square,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import * as m from '@/paraglide/messages';
import type { ChapterUpdateJobStatus, ChapterUpdateJobKind } from '@/lib/state/status-vocabularies';
import type { RelayOutlineChapter, RelayOutlineNode } from './useUpdateWorkbench';

export interface RepoUpdateJobItem {
  id: string;
  documentId: string;
  path: string;
  status: ChapterUpdateJobStatus;
  kind?: ChapterUpdateJobKind;
  fromSha: string;
  toSha: string;
  claimedBy: string | null;
  voteDeadline: string | Date | null;
  frozenCredits: number;
  document?: {
    title: string | null;
  } | null;
}

export interface WorkbenchBatchViewProps {
  owner: string;
  repo: string;
  outline: RelayOutlineChapter[];
  jobs?: RepoUpdateJobItem[];
  loadingJobs: boolean;
  selectedIds: Set<string>;
  toggleSelect: (nodeId: string) => void;
  toggleSelectAll: () => void;
  allSelected: boolean;
  batchSubmitting: boolean;
  handleBatchClaim: () => void;
  handleSingleClaim?: (node: RelayOutlineNode) => void;
  claimingNodeId?: string | null;
  pendingJobs?: RepoUpdateJobItem[];
  trialJobs?: RepoUpdateJobItem[];
  handleSelectTrialJob?: (jobId: string) => void;
}

export function WorkbenchBatchView({
  owner,
  repo,
  outline,
  loadingJobs,
  selectedIds,
  toggleSelect,
  toggleSelectAll,
  allSelected,
  batchSubmitting,
  handleBatchClaim,
  handleSingleClaim,
  claimingNodeId,
}: WorkbenchBatchViewProps) {
  const allNodes = useMemo(() => outline.flatMap((ch) => ch.nodes || []), [outline]);
  const totalCount = allNodes.length;
  const processedCount = allNodes.filter((n) => n.status === 'PROCESSED').length;
  const inProgressCount = allNodes.filter((n) => n.status === 'CLAIMED').length;
  const claimableCount = allNodes.filter((n) => n.status === 'UNPROCESSED').length;

  const [filter, setFilter] = useState<'claimable' | 'processed' | 'all'>('claimable');

  const [collapsedChapters, setCollapsedChapters] = useState<Record<string, boolean>>({});

  const toggleChapterCollapse = (chapterId: string) => {
    setCollapsedChapters((prev) => ({
      ...prev,
      [chapterId]: !prev[chapterId],
    }));
  };

  const filteredOutline = useMemo(() => {
    return outline
      .map((ch) => {
        const nodes = (ch.nodes || []).filter((n) => {
          if (filter === 'claimable') return n.status === 'UNPROCESSED';
          if (filter === 'processed') return n.status === 'PROCESSED';
          return true;
        });
        return { ...ch, nodes };
      })
      .filter((ch) => ch.nodes.length > 0);
  }, [outline, filter]);

  const isAnyClaiming = batchSubmitting || claimingNodeId !== null;

  return (
    <div className="flex-1 min-h-0 flex flex-col justify-between p-5 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-theme-border/60 text-xs shrink-0">
        <div className="flex items-center gap-1.5 p-0.5 rounded-xl bg-theme-surface border border-theme-border/70">
          <button
            type="button"
            onClick={() => setFilter('claimable')}
            className={cn(
              'px-2.5 py-1 rounded-lg font-medium transition-all cursor-pointer flex items-center gap-1.5 text-xs',
              filter === 'claimable'
                ? 'bg-theme-bg text-theme-foreground shadow-2xs font-bold border border-theme-border/60'
                : 'text-theme-muted hover:text-theme-foreground'
            )}
          >
            <span>{m.workbench_filter_untranscribed()}</span>
            <span className="font-mono text-micro px-1 rounded-md bg-theme-primary/10 text-theme-primary font-bold">
              {claimableCount}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setFilter('processed')}
            className={cn(
              'px-2.5 py-1 rounded-lg font-medium transition-all cursor-pointer flex items-center gap-1.5 text-xs',
              filter === 'processed'
                ? 'bg-theme-bg text-theme-foreground shadow-2xs font-bold border border-theme-border/60'
                : 'text-theme-muted hover:text-theme-foreground'
            )}
          >
            <span>{m.workbench_filter_completed()}</span>
            <span className="font-mono text-micro px-1 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-bold">
              {processedCount}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setFilter('all')}
            className={cn(
              'px-2.5 py-1 rounded-lg font-medium transition-all cursor-pointer flex items-center gap-1.5 text-xs',
              filter === 'all'
                ? 'bg-theme-bg text-theme-foreground shadow-2xs font-bold border border-theme-border/60'
                : 'text-theme-muted hover:text-theme-foreground'
            )}
          >
            <span>{m.workbench_filter_all()}</span>
            <span className="font-mono text-micro px-1 rounded-md text-theme-muted">
              {totalCount}
            </span>
          </button>
        </div>

        {claimableCount > 0 && filter !== 'processed' && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleSelectAll}
              disabled={loadingJobs || isAnyClaiming}
              className="inline-flex items-center gap-1.5 text-xs text-theme-muted hover:text-theme-foreground font-medium transition-colors cursor-pointer disabled:opacity-40"
            >
              {allSelected ? (
                <CheckSquare className="w-4 h-4 text-theme-primary" />
              ) : (
                <Square className="w-4 h-4" />
              )}
              <span>{m.workbench_select_all_claimable()}</span>
            </button>

            {selectedIds.size > 0 && (
              <span className="text-micro font-mono px-2 py-0.5 rounded-full bg-theme-primary/10 text-theme-primary border border-theme-primary/20 font-bold">
                {m.workbench_selected_count({ count: selectedIds.size })}
              </span>
            )}
          </div>
        )}
      </div>

      {loadingJobs && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-theme-muted py-16">
          <Loader2 className="w-5 h-5 animate-spin text-theme-primary" />
          <span className="text-xs font-mono">{m.workbench_batch_status_checking()}</span>
        </div>
      )}

      {!loadingJobs && filteredOutline.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center py-16">
          <div className="w-9 h-9 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-600">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <p className="text-xs font-medium text-theme-muted">
            {filter === 'claimable'
              ? m.workbench_empty_all_completed()
              : filter === 'processed'
                ? m.workbench_empty_no_completed()
                : m.workbench_empty_no_chapters()}
          </p>
        </div>
      )}

      {!loadingJobs && filteredOutline.length > 0 && (
        <div className="flex-1 min-h-0 overflow-y-auto space-y-3.5 pr-1 pt-3">
          {filteredOutline.map((chapter) => {
            const chNodes = chapter.nodes || [];
            const isCollapsed = !!collapsedChapters[chapter.id];

            return (
              <div
                key={chapter.id}
                className="rounded-xl border border-theme-border/60 bg-theme-surface/40 overflow-hidden transition-all"
              >
                <button
                  type="button"
                  onClick={() => toggleChapterCollapse(chapter.id)}
                  className="w-full px-3.5 py-2 bg-theme-surface/70 hover:bg-theme-surface/90 border-b border-theme-border/40 flex items-center justify-between gap-2.5 text-left transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-theme-muted shrink-0">
                      {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </span>
                    <BookOpen className="w-3.5 h-3.5 text-theme-primary shrink-0" />
                    <h4 className="text-xs font-serif font-bold text-theme-foreground truncate">
                      {chapter.title}
                    </h4>
                  </div>

                  <span className="font-mono text-micro text-theme-muted shrink-0">
                    {m.workbench_section_count({ count: chNodes.length })}
                  </span>
                </button>

                {!isCollapsed && (
                  <div className="divide-y divide-theme-border/25">
                    {chNodes.map((node) => {
                      const isProcessed = node.status === 'PROCESSED';
                      const isClaimed = node.status === 'CLAIMED';
                      const isUnprocessed = node.status === 'UNPROCESSED';
                      const isSelected = selectedIds.has(node.id);
                      const isClaimingThis = claimingNodeId === node.id;
                      const readUrl = `/docs/${owner}/${repo}/${docPathToSlug(node.path)}`;

                      return (
                        <div
                          key={node.id}
                          className={cn(
                            'px-3.5 py-2.5 flex items-center justify-between gap-3 transition-colors',
                            isSelected
                              ? 'bg-theme-primary/[0.06]'
                              : isProcessed
                                ? 'bg-theme-bg/30 hover:bg-theme-bg/70'
                                : isClaimed
                                  ? 'bg-theme-surface/20'
                                  : 'hover:bg-theme-surface/60'
                          )}
                        >
                          <div className="flex items-center gap-2.5 min-w-0 flex-1">
                            <div className="shrink-0 flex items-center justify-center w-4">
                              {isUnprocessed ? (
                                <button
                                  type="button"
                                  onClick={() => toggleSelect(node.id)}
                                  disabled={isAnyClaiming}
                                  className="text-theme-primary focus:outline-none cursor-pointer disabled:opacity-40"
                                >
                                  {isSelected ? (
                                    <CheckSquare className="w-4 h-4 text-theme-primary" />
                                  ) : (
                                    <Square className="w-4 h-4 text-theme-muted hover:text-theme-foreground" />
                                  )}
                                </button>
                              ) : isProcessed ? (
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                              ) : (
                                <Lock className="w-3.5 h-3.5 text-theme-muted/70 shrink-0" />
                              )}
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span
                                  className={cn(
                                    'text-xs font-serif font-medium truncate',
                                    isProcessed
                                      ? 'text-theme-foreground'
                                      : isClaimed
                                        ? 'text-theme-muted'
                                        : 'text-theme-foreground'
                                  )}
                                >
                                  {node.title}
                                </span>

                                {isProcessed && (
                                  <span className="inline-flex items-center px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-micro font-bold">
                                    {m.workbench_status_completed()}
                                    {(node.versionCount ?? 0) > 1 && ` · ${node.versionCount}版`}
                                  </span>
                                )}
                                {isClaimed && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded bg-theme-surface border border-theme-border/60 text-theme-muted text-micro">
                                    <Users className="w-2.5 h-2.5 text-theme-primary" />
                                    {node.claimedBy || m.relay_status_in_progress()}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="shrink-0 flex items-center gap-2">
                            {isProcessed && (
                              <Link
                                href={readUrl}
                                target="_blank"
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-theme-border/70 bg-theme-bg hover:bg-theme-surface text-xs text-theme-foreground transition-all cursor-pointer shadow-2xs font-medium"
                              >
                                <ExternalLink className="w-3 h-3 text-theme-muted" />
                                <span>{m.common_read()}</span>
                              </Link>
                            )}

                            {isUnprocessed && handleSingleClaim && (
                              <button
                                type="button"
                                onClick={() => handleSingleClaim(node)}
                                disabled={isAnyClaiming}
                                className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-theme-primary/10 hover:bg-theme-primary text-theme-primary hover:text-theme-primary-fg border border-theme-primary/25 hover:border-theme-primary text-xs font-bold transition-all cursor-pointer disabled:opacity-40 shadow-2xs"
                              >
                                {isClaimingThis ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Sparkles className="w-3 h-3" />
                                )}
                                <span>{isClaimingThis ? m.relay_transcribing_time({ seconds: '' }).trim() : m.relay_action_transcribe()}</span>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="mt-2.5 pt-2.5 border-t border-theme-border/60 flex items-center justify-between gap-3 shrink-0 bg-theme-surface/80 border border-theme-border/60 px-3.5 py-2.5 rounded-xl shadow-sm">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-serif font-bold text-theme-foreground">
              {m.workbench_selected_items({ count: selectedIds.size })}
            </span>
          </div>

          <button
            type="button"
            onClick={handleBatchClaim}
            disabled={isAnyClaiming}
            className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-lg bg-theme-primary text-theme-primary-fg text-xs font-bold hover:opacity-90 transition-all cursor-pointer disabled:opacity-50 shrink-0 shadow-sm"
          >
            {batchSubmitting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ArrowUpCircle className="w-3.5 h-3.5" />
            )}
            <span>
              {batchSubmitting ? m.workbench_batch_transcribing() : m.workbench_batch_transcribe_cta({ count: selectedIds.size })}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
