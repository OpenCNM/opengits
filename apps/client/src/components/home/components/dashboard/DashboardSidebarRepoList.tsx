'use client';

import React from 'react';
import Link from 'next/link';
import { Globe, Layers, ArrowUpCircle, Pin, Sparkles } from 'lucide-react';
import { DisplayRepo, EditionChip } from '@/lib/home-data';
import { isWebDocRepository, resolveRepositoryDisplayName } from '@/lib/repository-resolver';
import { GithubIcon } from '@/components/repo/RepoGithubOriginPopover';
import { Tooltip, TooltipTrigger, TooltipPopup, TooltipProvider } from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';
import * as m from '@/paraglide/messages';

interface DashboardSidebarRepoListProps {
  repos: DisplayRepo[];
  editionsOf: (repo: DisplayRepo) => EditionChip[] | undefined;
  isFiltered?: boolean;
  checkingRepoId?: string | null;
  onOpenEditionDrawer?: (drawer: { editions: EditionChip[]; owner: string; repo: string }) => void;
  onOpenUpdateDialog?: (target: { owner: string; repo: string; branch?: string; edition?: string }) => void;
  onCheckUpdate?: (repo: DisplayRepo) => void;
  onTogglePin?: (repo: DisplayRepo) => void;
  onEditionSavedChange?: (chip: EditionChip, isSaved: boolean) => void;
  onCreateEdition?: (owner: string, repo: string) => void;
  onOpenDetail?: (repo: DisplayRepo) => void;
  onOpenStarterPacks?: () => void;
}

export function DashboardSidebarRepoList({
  repos,
  editionsOf,
  isFiltered = false,
  checkingRepoId: _checkingRepoId,
  onOpenEditionDrawer: _onOpenEditionDrawer,
  onOpenUpdateDialog,
  onCheckUpdate: _onCheckUpdate,
  onTogglePin,
  onEditionSavedChange: _onEditionSavedChange,
  onCreateEdition: _onCreateEdition,
  onOpenDetail,
  onOpenStarterPacks,
}: DashboardSidebarRepoListProps) {
  return (
    <ScrollArea className="flex-1 min-h-0" scrollFade scrollbarGutter>
        <div className="space-y-1 font-sans text-sm pr-1 py-0.5">
          {repos.length === 0 ? (
          <div className="py-6 px-3 border border-dashed border-theme-border/80 rounded-lg text-center space-y-2 my-2">
            {isFiltered ? (
              <p className="text-xs font-medium text-theme-muted">{m.dashboard_manage_empty()}</p>
            ) : (
              <>
                <p className="text-xs font-medium text-theme-foreground/80">{m.empty_no_bookshelf()}</p>
                <p className="text-micro text-theme-muted/70">{m.mcp_empty_bookshelf_hint()}</p>
                {onOpenStarterPacks && (
                  <button
                    type="button"
                    onClick={onOpenStarterPacks}
                    className="mt-1.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-theme-surface border border-theme-border hover:border-theme-primary text-xs font-medium text-theme-foreground transition-colors cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-theme-primary" />
                    <span>{m.starter_pack_empty_cta()}</span>
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          repos.map((r) => {
            const docSlug = r.lastReadPath ? r.lastReadPath.replace(/\.mdx?$/, '') : '';
            const docUrl = `/docs/${r.owner}/${r.repo}${docSlug ? '/' + docSlug : ''}`;
            const rEditions = editionsOf(r);

            const isWebDoc = isWebDocRepository(r);
            const displayTitle = resolveRepositoryDisplayName(r);

            const itemContent = (
              <>
                <span className="truncate text-theme-foreground group-hover:text-theme-primary-fg font-medium text-xs sm:text-sm flex-1 min-w-0 flex items-center gap-1.5">
                  {isWebDoc ? (
                    <Globe className="w-3.5 h-3.5 text-theme-muted group-hover:text-theme-primary-fg shrink-0 transition-colors" />
                  ) : (
                    <GithubIcon className="w-3.5 h-3.5 text-theme-foreground/80 group-hover:text-theme-primary-fg shrink-0 transition-colors" />
                  )}
                  {isWebDoc ? (
                    <strong className="font-semibold truncate">{displayTitle}</strong>
                  ) : (
                    <span className="truncate">{r.owner}/<strong className="font-semibold">{r.repo}</strong></span>
                  )}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* 上游更新指示图标 */}
                  {(r.hasUpdate || r.hasUpstreamUpdate) && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (onOpenUpdateDialog) {
                              onOpenUpdateDialog({ owner: r.owner, repo: r.repo, branch: r.branch, edition: r.edition });
                            } else if (onOpenDetail) {
                              onOpenDetail(r);
                            }
                          }}
                          className="p-1 rounded-md text-amber-500 group-hover:text-theme-primary-fg hover:bg-amber-500/10 transition-all cursor-pointer shrink-0 inline-flex items-center"
                          aria-label={m.dashboard_upstream_has_update()}
                        >
                          <ArrowUpCircle className="w-4 h-4 animate-pulse stroke-[2.2]" />
                        </TooltipTrigger>
                        <TooltipPopup side="top" className="bg-theme-surface text-theme-foreground border border-theme-border font-sans text-xs px-2.5 py-1 rounded-lg shadow-sm z-50">
                          {m.dashboard_upstream_has_update()}
                        </TooltipPopup>
                      </Tooltip>
                    </TooltipProvider>
                  )}

                  {/* 版本数徽章（多版本时展示） */}
                  {rEditions && rEditions.length > 1 && (
                    <span
                      title={m.dashboard_editions_count({ count: rEditions.length })}
                      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border border-theme-border/70 group-hover:border-theme-primary-fg/30 text-micro text-theme-muted group-hover:text-theme-primary-fg font-mono transition-all shrink-0"
                    >
                      <Layers className="w-3 h-3" />
                      ×{rEditions.length}
                    </span>
                  )}

                  {/* 钉选操作（保留在行内快捷操作，stopPropagation） */}
                  {onTogglePin && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onTogglePin(r);
                          }}
                          className={`p-1 rounded-md transition-all cursor-pointer inline-flex items-center shrink-0 ${
                            r.isPinned
                              ? 'text-theme-primary group-hover:text-theme-primary-fg'
                              : 'text-theme-muted/50 group-hover:text-theme-primary-fg/70 hover:!text-theme-primary-fg opacity-0 group-hover:opacity-100 hover:bg-theme-primary-fg/10'
                          }`}
                          aria-label={r.isPinned ? m.dashboard_unpin() : m.dashboard_pin()}
                        >
                          <Pin className={`w-3.5 h-3.5 transition-transform ${r.isPinned ? 'rotate-45 fill-current' : '-rotate-12'}`} />
                        </TooltipTrigger>
                        <TooltipPopup side="top" className="bg-theme-surface text-theme-foreground border border-theme-border font-sans text-xs px-2.5 py-1 rounded-lg shadow-sm z-50">
                          {r.isPinned ? m.dashboard_unpin() : m.dashboard_pin()}
                        </TooltipPopup>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              </>
            );

            return onOpenDetail ? (
              <div
                key={r.id}
                role="button"
                tabIndex={0}
                onClick={() => onOpenDetail(r)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpenDetail(r);
                  }
                }}
                className="w-full flex items-center justify-between p-2 rounded-xl hover:bg-theme-primary hover:text-theme-primary-fg transition-colors group gap-2 cursor-pointer text-left outline-none focus:outline-none focus-visible:ring-1 focus-visible:ring-theme-primary/40"
              >
                {itemContent}
              </div>
            ) : (
              <Link
                key={r.id}
                href={docUrl}
                className="flex items-center justify-between p-2 rounded-xl hover:bg-theme-primary hover:text-theme-primary-fg transition-colors group gap-2"
              >
                {itemContent}
              </Link>
            );
          })
        )}
        </div>
      </ScrollArea>
  );
}
