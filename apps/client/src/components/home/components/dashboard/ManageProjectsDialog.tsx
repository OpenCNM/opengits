'use client';

import React, { useState, useMemo } from 'react';
import {
  FolderKanban,
  Search,
  X,
  Pin,
  Trash2,
  Globe,
  ExternalLink,
} from 'lucide-react';
import { DisplayRepo } from '@/lib/home-data';
import { isWebDocRepository, resolveRepositoryDisplayName } from '@/lib/repository-resolver';
import { GithubIcon } from '@/components/repo/RepoGithubOriginPopover';
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import * as m from '@/paraglide/messages';

export interface ManageProjectsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repos: DisplayRepo[];
  onTogglePin?: (repo: DisplayRepo) => void;
  onRemoveRepo?: (repo: DisplayRepo) => Promise<void> | void;
  onOpenDetail?: (repo: DisplayRepo) => void;
}

export function ManageProjectsDialog({
  open,
  onOpenChange,
  repos,
  onTogglePin,
  onRemoveRepo,
  onOpenDetail,
}: ManageProjectsDialogProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [removingRepo, setRemovingRepo] = useState<DisplayRepo | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  // Filter repos based on dialog search input
  const filteredRepos = useMemo(() => {
    if (!searchQuery.trim()) return repos;
    const q = searchQuery.toLowerCase().trim();
    return repos.filter((r) => {
      const displayTitle = resolveRepositoryDisplayName(r).toLowerCase();
      const owner = (r.owner || '').toLowerCase();
      const name = (r.repo || '').toLowerCase();
      return displayTitle.includes(q) || owner.includes(q) || name.includes(q);
    });
  }, [repos, searchQuery]);

  const pinnedCount = useMemo(() => {
    return repos.filter((r) => r.isPinned).length;
  }, [repos]);

  const handleConfirmRemove = async () => {
    if (!removingRepo || !onRemoveRepo) return;
    try {
      setIsRemoving(true);
      await onRemoveRepo(removingRepo);
    } finally {
      setIsRemoving(false);
      setRemovingRepo(null);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPopup className="max-w-xl sm:max-w-2xl h-[32rem] sm:h-[34rem] max-h-[75vh] flex flex-col bg-theme-bg border border-theme-border select-none p-0 overflow-hidden">
          {/* Header */}
          <DialogHeader className="shrink-0 p-5 sm:p-6 border-b border-theme-border/60 pb-3.5">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-theme-primary/10 border border-theme-primary/20 flex items-center justify-center shrink-0">
                <FolderKanban className="w-4 h-4 text-theme-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <DialogTitle className="text-base sm:text-lg font-bold text-theme-foreground flex items-center gap-2">
                  <span>{m.dashboard_manage_dialog_title()}</span>
                  <span className="text-xs font-mono font-normal text-theme-muted px-2 py-0.5 rounded-full bg-theme-surface border border-theme-border/60">
                    {repos.length}
                  </span>
                </DialogTitle>
                <DialogDescription className="text-micro text-theme-muted mt-0.5 line-clamp-1">
                  {m.dashboard_manage_dialog_desc()}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {/* Search Filter Bar */}
          <div className="shrink-0 px-5 sm:px-6 pt-3.5 pb-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-theme-muted absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={m.dashboard_manage_search_placeholder()}
                className="w-full h-9 pl-8.5 pr-8 bg-theme-surface/50 border border-theme-border/80 rounded-lg text-xs font-sans text-theme-foreground outline-none focus:border-theme-primary focus:bg-theme-bg transition-colors placeholder:text-theme-muted/60"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-theme-muted hover:text-theme-foreground p-0.5 rounded cursor-pointer"
                  aria-label={m.common_close()}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Project List */}
          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 sm:px-6 py-2">
            <div className="space-y-2 pr-1 py-1">
              {filteredRepos.length === 0 ? (
                <div className="py-12 px-4 text-center border border-dashed border-theme-border/80 rounded-xl my-2">
                  <p className="text-xs font-medium text-theme-muted">
                    {searchQuery ? m.dashboard_manage_empty() : m.empty_no_bookshelf()}
                  </p>
                </div>
              ) : (
                  filteredRepos.map((repo) => {
                    const isWebDoc = isWebDocRepository(repo);
                    const displayTitle = resolveRepositoryDisplayName(repo);

                    return (
                      <div
                        key={repo.id}
                        className={`group p-3 rounded-xl border transition-all flex items-center justify-between gap-3 ${
                          repo.isPinned
                            ? 'bg-theme-surface/60 border-theme-primary/30 shadow-xs'
                            : 'bg-theme-surface/30 hover:bg-theme-surface/60 border-theme-border/60'
                        }`}
                      >
                        {/* Left: Project Identity & Metadata */}
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div className="w-8 h-8 rounded-lg bg-theme-bg border border-theme-border/60 flex items-center justify-center shrink-0">
                            {isWebDoc ? (
                              <Globe className="w-4 h-4 text-theme-muted" />
                            ) : (
                              <GithubIcon className="w-4 h-4 text-theme-foreground/80" />
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              {onOpenDetail ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    onOpenChange(false);
                                    onOpenDetail(repo);
                                  }}
                                  className="font-semibold text-xs sm:text-sm text-theme-foreground hover:text-theme-primary transition-colors truncate text-left cursor-pointer flex items-center gap-1 group/title"
                                >
                                  {isWebDoc ? (
                                    <span className="truncate">{displayTitle}</span>
                                  ) : (
                                    <span className="truncate">
                                      <span className="text-theme-muted font-normal">{`${repo.owner}/`}</span>
                                      {repo.repo}
                                    </span>
                                  )}
                                  <ExternalLink className="w-3 h-3 text-theme-muted opacity-0 group-hover/title:opacity-100 transition-opacity shrink-0" />
                                </button>
                              ) : (
                                <span className="font-semibold text-xs sm:text-sm text-theme-foreground truncate">
                                  {isWebDoc ? (
                                    <span className="truncate">{displayTitle}</span>
                                  ) : (
                                    <span className="truncate">
                                      <span className="text-theme-muted font-normal">{`${repo.owner}/`}</span>
                                      {repo.repo}
                                    </span>
                                  )}
                                </span>
                              )}

                              {repo.isPinned && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-micro font-medium bg-theme-primary/10 text-theme-primary border border-theme-primary/20 shrink-0">
                                  <Pin className="w-2.5 h-2.5 rotate-45 fill-current" />
                                  <span>{m.dashboard_manage_pinned_badge()}</span>
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-2 mt-0.5 text-micro text-theme-muted">
                              <span className="truncate">
                                {isWebDoc ? m.dashboard_source_webdoc() : m.dashboard_source_github()}
                              </span>
                              {repo.editionGroup?.editions && repo.editionGroup.editions.length > 1 && (
                                <>
                                  <span>·</span>
                                  <span>
                                    {m.dashboard_editions_count({ count: repo.editionGroup.editions.length })}
                                  </span>
                                </>
                              )}
                              {repo.lastReadChapterTitle && (
                                <>
                                  <span>·</span>
                                  <span className="truncate max-w-[12rem]">
                                    {repo.lastReadChapterTitle}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Right: Actions */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          {/* Pin Toggle Button */}
                          {onTogglePin && (
                            <button
                              type="button"
                              onClick={() => onTogglePin(repo)}
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-sans font-medium border transition-all cursor-pointer shrink-0 ${
                                repo.isPinned
                                  ? 'text-theme-primary bg-theme-primary/15 hover:bg-theme-primary/25 border-theme-primary/40 shadow-xs'
                                  : 'text-theme-muted hover:text-theme-foreground hover:bg-theme-surface border-theme-border/60'
                              }`}
                              title={repo.isPinned ? m.dashboard_unpin() : m.dashboard_pin()}
                            >
                              <Pin className={`w-3.5 h-3.5 ${repo.isPinned ? 'rotate-45 fill-current' : ''}`} />
                              <span>
                                {repo.isPinned ? m.dashboard_manage_unpin_action() : m.dashboard_manage_pin_action()}
                              </span>
                            </button>
                          )}

                          {/* Remove Button */}
                          {onRemoveRepo && (
                            <button
                              type="button"
                              onClick={() => setRemovingRepo(repo)}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-sans font-medium text-theme-accent/80 hover:text-white bg-theme-accent/5 hover:bg-theme-accent border border-theme-accent/20 transition-all cursor-pointer shrink-0"
                              title={repo.isPublic ? m.dashboard_manage_remove_action() : m.common_delete()}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>
                                {repo.isPublic ? m.dashboard_manage_remove_action() : m.common_delete()}
                              </span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

          {/* Footer */}
          <DialogFooter className="shrink-0 px-5 sm:px-6 py-3 border-t border-theme-border/60 bg-theme-surface/30 flex items-center justify-between">
            <span className="text-xs font-mono text-theme-muted">
              {m.dashboard_manage_stats({ total: repos.length, pinned: pinnedCount })}
            </span>
            <Button
              type="button"
              variant="default"
              onClick={() => onOpenChange(false)}
              className="px-4 py-1.5 text-xs font-medium cursor-pointer"
            >
              {m.common_done()}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {/* Confirmation Dialog for Removal */}
      <ConfirmDialog
        open={!!removingRepo}
        onOpenChange={(open) => {
          if (!open && !isRemoving) setRemovingRepo(null);
        }}
        title={
          removingRepo?.isPublic
            ? m.dashboard_remove_project_confirm_title()
            : m.dashboard_remove_personal_project_confirm_title()
        }
        description={
          removingRepo
            ? `${removingRepo.owner}/${removingRepo.repo} · ${
                removingRepo.isPublic
                  ? m.dashboard_remove_project_confirm_desc()
                  : m.dashboard_remove_personal_project_confirm_desc()
              }`
            : m.dashboard_remove_project_confirm_desc()
        }
        confirmText={
          isRemoving
            ? m.common_deleting()
            : (removingRepo?.isPublic ? m.shelf_saved_remove() : m.common_confirm_delete())
        }
        cancelText={m.common_cancel()}
        variant="danger"
        onConfirm={handleConfirmRemove}
      />
    </>
  );
}
