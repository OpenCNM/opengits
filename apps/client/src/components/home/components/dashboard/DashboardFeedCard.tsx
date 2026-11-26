'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { Globe, Check, Star, Eye, Activity, ArrowRight, Sparkles, BookOpen, Users, Layers } from 'lucide-react';
import { DisplayRepo, EditionChip } from '@/lib/home-data';
import { formatCompactNumber, formatProgressPercent, formatRelativeTime } from '@/lib/format';
import { isNativeWebDocMirror } from '@/lib/repository-origin';
import {
  extractWebDocOrigin,
  isWebDocRepository,
  resolveLocalizedRepoDescription,
  resolveRepositoryDisplayName,
} from '@/lib/repository-resolver';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { GithubIcon } from '@/components/repo/RepoGithubOriginPopover';
import { Tooltip, TooltipTrigger, TooltipPopup, TooltipProvider } from '@/components/ui/tooltip';
import { RelayAvatarStack } from '@/components/update/RelayAvatarStack';
import { resolveEditionChipDisplayLabel } from '@/lib/edition';
import { ENGINE_CONFIG } from '@/lib/config';
import * as m from '@/paraglide/messages';

interface DashboardFeedCardProps {
  repo: DisplayRepo;
  editions?: EditionChip[];
  followOn?: boolean;
  onToggleFollow?: (repo: DisplayRepo, next: boolean) => void;
  onToggleSave?: (repo: DisplayRepo) => void;
  onToggleFavorite?: (repo: DisplayRepo) => void;
  onOpenEditionDrawer?: (drawer: { editions: EditionChip[]; owner: string; repo: string }) => void;
  onOpenRelayWorkbench?: (repo: DisplayRepo) => void;
  onEditionSavedChange?: (chip: EditionChip, isSaved: boolean) => void;
  onCreateEdition?: () => void;
  onOpenDetail: (repo: DisplayRepo) => void;
  isHighlighted?: boolean;
  onSearchTag?: (tag: string) => void;
}

export function DashboardFeedCard({
  repo,
  editions,
  followOn,
  onToggleFollow,
  onToggleFavorite,
  onOpenRelayWorkbench,
  onEditionSavedChange,
  onCreateEdition,
  onOpenDetail,
  isHighlighted = false,
  onSearchTag,
}: DashboardFeedCardProps) {
  const { locale } = useLocale();
  const isWebDoc = isWebDocRepository(repo);
  const displayTitle = resolveRepositoryDisplayName(repo);
  const localizedDescription = resolveLocalizedRepoDescription(repo, locale);
  const webDocOrigin = isWebDoc ? extractWebDocOrigin(repo) : { host: '', endpoint: '' };

  const distinctBranches = Array.from(
    new Set((editions?.map((e) => e.branch).filter(Boolean) as string[]) || [])
  );
  const isMultiBranch = distinctBranches.length > 1;

  const chapterCounts = Array.from(
    new Set(
      editions
        ?.map((e) => e.chapterCount)
        .filter((c): c is number => typeof c === 'number' && c > 0) || []
    )
  );
  const chapterLabel =
    chapterCounts.length > 1
      ? `${Math.min(...chapterCounts)}-${Math.max(...chapterCounts)} ${m.dashboard_chapter()}`
      : `${repo.chapterCount || repo.processedDocsCount || 1} ${m.dashboard_chapter()}`;

  const updatedRelativeTime = formatRelativeTime(repo.updatedAt || repo.createdAt);

  const cardRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (isHighlighted && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isHighlighted]);

  return (
    <TooltipProvider>
      <div className="space-y-2.5" ref={cardRef}>
        <div className="flex items-start justify-between text-sm gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Tooltip>
              <TooltipTrigger
                type="button"
                onClick={(e) => e.stopPropagation()}
                className="shrink-0 inline-flex items-center cursor-default outline-none"
                aria-label={isWebDoc ? m.repo_origin_web_doc() : m.repo_origin_github()}
              >
                {isWebDoc ? (
                  <Globe className="w-4 h-4 text-theme-muted shrink-0" />
                ) : (
                  <GithubIcon className="w-4 h-4 text-theme-foreground/80 shrink-0" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="top" className="bg-theme-surface text-theme-foreground border border-theme-border font-sans text-xs px-2.5 py-1 rounded-lg shadow-sm z-50">
                {isWebDoc ? m.repo_origin_web_doc() : m.repo_origin_github()}
              </TooltipPopup>
            </Tooltip>
            <span className="text-theme-foreground font-semibold text-sm truncate group-hover:text-theme-foreground transition-colors">
              {isWebDoc ? (
                <strong className="font-semibold">{displayTitle}</strong>
              ) : (
                <>{repo.owner}/<strong className="font-semibold">{repo.repo}</strong></>
              )}
            </span>
            {editions && editions.length > 1 && (
              <span
                className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-theme-surface text-micro font-sans font-medium text-theme-muted shrink-0 border border-theme-border/60"
                title={m.dashboard_editions_count({ count: editions.length })}
              >
                <Layers className="w-3 h-3 text-theme-primary" />
                <span>{m.dashboard_editions_count({ count: editions.length })}</span>
              </span>
            )}
            {isHighlighted && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-theme-primary/10 text-theme-primary text-micro font-sans font-semibold shrink-0">
                <Sparkles className="w-2.5 h-2.5 shrink-0" />
                <span>{m.dashboard_target_tutorial()}</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <Tooltip>
              <TooltipTrigger
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFavorite?.(repo);
                }}
                className="group/fav flex items-center gap-1 text-xs text-theme-muted font-mono px-1 py-0.5 rounded-md hover:bg-theme-surface transition-colors cursor-pointer outline-none"
                aria-label={
                  repo.isFavorited ? m.dashboard_unfavorite_action() : m.dashboard_favorite_action()
                }
              >
                <Star
                  className={`w-3.5 h-3.5 transition-colors ${
                    repo.isFavorited
                      ? 'text-amber-500 fill-amber-500/20'
                      : 'text-theme-muted/60 group-hover/fav:text-amber-500/80'
                  }`}
                />
                {(repo.favoriteCount ?? 0) > 0 && <span>{repo.favoriteCount}</span>}
              </TooltipTrigger>
              <TooltipPopup side="top" className="bg-theme-surface text-theme-foreground border border-theme-border font-sans text-xs px-2.5 py-1 rounded-lg shadow-sm z-50">
                {repo.isFavorited ? m.dashboard_unfavorite_action() : m.dashboard_favorite_action()}
              </TooltipPopup>
            </Tooltip>
            {repo.isSaved ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-micro font-sans font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20">
                <Check className="w-3 h-3 stroke-[2.5]" />
                <span>{m.shelf_in_personal_project()}</span>
              </span>
            ) : typeof repo.shelfFeeEstimate === 'number' && repo.shelfFeeEstimate > 0 ? (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-micro font-mono font-medium text-theme-muted bg-theme-surface border border-theme-border/60"
                title={m.shelf_fee_price({ count: repo.shelfFeeEstimate })}
              >
                <span>{m.shelf_fee_card_badge({ count: repo.shelfFeeEstimate })}</span>
              </span>
            ) : typeof repo.shelfFeeEstimate === 'number' && repo.shelfFeeEstimate === 0 ? (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-micro font-mono font-medium text-theme-muted/80 bg-theme-surface border border-theme-border/60"
                title={m.shelf_confirm_fee_free()}
              >
                <span>{m.shelf_fee_free_badge()}</span>
              </span>
            ) : null}
          </div>
        </div>

        {repo.relay && repo.relay.done < repo.relay.total && (
          <div className="space-y-1.5 py-0.5">
            <div className="flex items-center justify-between gap-2 min-h-6">
              <span
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-theme-surface border border-theme-border/80 text-xs font-mono text-theme-foreground shrink-0 shadow-2xs"
                title={m.dashboard_relay_progress_title({ done: repo.relay.done, total: repo.relay.total })}
              >
                <Users className="w-3.5 h-3.5 text-theme-foreground/70 shrink-0" />
                <span className="font-semibold text-theme-foreground">{m.dashboard_relay_tag({ done: repo.relay.done, total: repo.relay.total })}</span>
                {repo.relay.inProgress > 0 && (
                  <span className="relative flex h-1.5 w-1.5 ml-0.5" title={m.relay_chapters_in_progress({ count: repo.relay.inProgress })}>
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                  </span>
                )}
              </span>

              {repo.relay.total > 0 && (
                <span className="text-micro font-mono text-theme-muted/80">
                  {formatProgressPercent(repo.relay.done, repo.relay.total)}%
                </span>
              )}
            </div>

            <div className="h-1.5 w-full rounded-full bg-theme-border/60 overflow-hidden">
              <div
                className="h-full rounded-full bg-theme-primary/70 transition-all"
                style={{
                  width: `${formatProgressPercent(repo.relay.done, repo.relay.total)}%`,
                }}
              />
            </div>

            {repo.relay.done < repo.relay.total ? (
              <div className="flex items-center justify-between gap-2 pt-0.5">
                <span className="text-micro font-mono text-theme-muted truncate">
                  {repo.relay.inProgress > 0
                    ? m.relay_chapters_in_progress({ count: repo.relay.inProgress })
                    : m.relay_waiting_community()}
                </span>
                <div className="flex items-center gap-2.5 shrink-0">
                  {repo.relay.participants?.length > 0 && (
                    <RelayAvatarStack participants={repo.relay.participants} maxVisible={3} size="xs" />
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenRelayWorkbench?.(repo);
                    }}
                    className="inline-flex items-center gap-1 text-xs font-medium text-theme-primary hover:text-theme-primary/80 transition-colors cursor-pointer shrink-0 font-sans group/relay"
                  >
                    <span>{m.dashboard_join_relay()}</span>
                    <ArrowRight className="w-3.5 h-3.5 group-hover/relay:translate-x-0.5 transition-transform" />
                  </button>
                </div>
              </div>
            ) : (
              repo.relay.participants?.length > 0 && (
                <div className="flex items-center justify-end gap-2 pt-0.5">
                  <RelayAvatarStack participants={repo.relay.participants} maxVisible={3} size="xs" />
                </div>
              )
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 text-micro font-mono text-theme-muted/70 min-w-0">
          <div className="flex items-center gap-2 min-w-0 flex-1 truncate">
            <span className="text-theme-foreground/80 font-medium truncate">
              {isWebDoc ? (webDocOrigin.endpoint || webDocOrigin.host || 'doc') : `git:${repo.owner}/${repo.repo}`}
            </span>
            <span className="shrink-0">•</span>
            <span className="shrink-0">{chapterLabel}</span>
          </div>
          {!isWebDoc && isMultiBranch ? (
            <Tooltip>
              <TooltipTrigger
                type="button"
                onClick={(e) => e.stopPropagation()}
                className="text-micro text-theme-muted/70 hover:text-theme-foreground transition-colors truncate cursor-default outline-none inline-flex items-center gap-1 shrink-0"
              >
                <span>ref: {m.dashboard_multi_branch({ branches: distinctBranches.join(', ') })}</span>
              </TooltipTrigger>
              <TooltipPopup side="top" className="bg-theme-surface text-theme-foreground border border-theme-border font-mono text-xs px-2.5 py-1.5 rounded-lg shadow-sm z-50 space-y-1">
                <div className="font-semibold text-theme-foreground/90 font-sans text-caption pb-0.5 border-b border-theme-border/40">
                  {m.dashboard_branch_mapping_title()}
                </div>
                {editions?.map((chip) => {
                  const label = resolveEditionChipDisplayLabel(chip);
                  const b = chip.branch || ENGINE_CONFIG.defaultBranch;
                  const sha = (chip.gitSha || chip.importedSha || '')?.slice(0, 7);
                  return (
                    <div key={chip.id} className="flex items-center justify-between gap-3 text-caption">
                      <span className="font-sans text-theme-muted">{label}:</span>
                      <span className="font-mono text-theme-foreground font-semibold">{b}{sha ? ` @ ${sha}` : ''}</span>
                    </div>
                  );
                })}
              </TooltipPopup>
            </Tooltip>
          ) : isWebDoc ? (
            (repo.gitSha || repo.importedSha) ? (
              <div className="text-micro text-theme-muted/60 truncate shrink-0">
                {m.web_doc_snapshot()} @ {(repo.gitSha || repo.importedSha)?.slice(0, 7)}
              </div>
            ) : null
          ) : repo.gitSha ? (
            <div className="text-micro text-theme-muted/60 truncate shrink-0">
              ref: {repo.branch || ENGINE_CONFIG.defaultBranch} @ {repo.gitSha.slice(0, 7)}
            </div>
          ) : null}
        </div>

        <p className="text-xs text-theme-muted line-clamp-2 leading-relaxed font-sans min-h-[2.5rem]">
          {localizedDescription ? (
            localizedDescription
          ) : (
            <span className="invisible select-none">{"\u00A0"}</span>
          )}
        </p>
      </div>

      <div className="pt-1 text-xs font-mono flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 sm:gap-3.5 text-xs font-mono text-theme-muted min-w-0">
          {typeof repo.views === 'number' && repo.views > 0 && (
            <Tooltip>
              <TooltipTrigger className="inline-flex items-center gap-1.5 text-theme-muted/80 cursor-default outline-none">
                <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{formatCompactNumber(repo.views)}</span>
              </TooltipTrigger>
              <TooltipPopup side="top" className="bg-theme-surface text-theme-foreground border border-theme-border font-mono text-xs px-2.5 py-1 rounded-lg shadow-sm z-50">
                {m.common_views_count({ count: repo.views.toLocaleString() })}
              </TooltipPopup>
            </Tooltip>
          )}

          {typeof repo.mcpCallCount === 'number' && repo.mcpCallCount > 0 && (
            <Tooltip>
              <TooltipTrigger className="inline-flex items-center gap-1.5 text-theme-muted/80 cursor-default outline-none">
                <Activity className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{formatCompactNumber(repo.mcpCallCount)}</span>
              </TooltipTrigger>
              <TooltipPopup side="top" className="bg-theme-surface text-theme-foreground border border-theme-border font-mono text-xs px-2.5 py-1 rounded-lg shadow-sm z-50">
                {m.common_mcp_calls_count({ count: repo.mcpCallCount.toLocaleString() })}
              </TooltipPopup>
            </Tooltip>
          )}

          {updatedRelativeTime && (
            <Tooltip>
              <TooltipTrigger className="hidden sm:inline-flex items-center text-theme-muted/80 cursor-default outline-none">
                <span>{m.dashboard_feed_updated_relative({ time: updatedRelativeTime })}</span>
              </TooltipTrigger>
              <TooltipPopup side="top" className="bg-theme-surface text-theme-foreground border border-theme-border font-mono text-xs px-2.5 py-1 rounded-lg shadow-sm z-50">
                {m.dashboard_updated_at({ time: new Date(repo.updatedAt || repo.createdAt || Date.now()).toLocaleDateString() })}
              </TooltipPopup>
            </Tooltip>
          )}

          {editions && editions.length > 1 ? (
            <div className="hidden md:inline-flex items-center gap-1 shrink-0">
              {editions.slice(0, 2).map((chip) => {
                const label = resolveEditionChipDisplayLabel(chip);
                const b = chip.branch || ENGINE_CONFIG.defaultBranch;
                const sha = (chip.gitSha || chip.importedSha || '')?.slice(0, 7);
                const tipText = isWebDoc
                  ? (sha ? `${label} · ${m.web_doc_snapshot()} @ ${sha}` : label)
                  : isMultiBranch
                    ? `${label} · ${b}${sha ? ` @ ${sha}` : ''}`
                    : label;
                return (
                  <Tooltip key={chip.id}>
                    <TooltipTrigger
                      type="button"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-theme-surface text-micro font-mono text-theme-muted border border-theme-border/60 hover:text-theme-foreground hover:border-theme-border transition-colors cursor-default outline-none"
                    >
                      <span>{label}</span>
                    </TooltipTrigger>
                    <TooltipPopup side="top" className="bg-theme-surface text-theme-foreground border border-theme-border font-mono text-xs px-2.5 py-1 rounded-lg shadow-sm z-50">
                      <span>{tipText}</span>
                    </TooltipPopup>
                  </Tooltip>
                );
              })}
              {editions.length > 2 && (
                <span className="text-micro font-mono text-theme-muted px-0.5">
                  +{editions.length - 2}
                </span>
              )}
            </div>
          ) : repo.transcriptionModels && repo.transcriptionModels.length > 0 ? (
            <Tooltip>
              <TooltipTrigger className="hidden md:inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-theme-surface text-micro font-mono text-theme-muted border border-theme-border/60 shrink-0 cursor-default outline-none">
                <span>{repo.transcriptionModels.join(', ')}</span>
              </TooltipTrigger>
              <TooltipPopup side="top" className="bg-theme-surface text-theme-foreground border border-theme-border font-sans text-xs px-2.5 py-1 rounded-lg shadow-sm z-50">
                {m.dashboard_transcription_models({ models: repo.transcriptionModels.join(', ') })}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {typeof repo.progress === 'number' && repo.progress > 0 && !isNativeWebDocMirror(repo) ? (
            <div className="relative inline-flex items-center justify-end">
              <div className="transition-opacity duration-150 group-hover:opacity-0 group-hover:pointer-events-none select-none">
                <Tooltip>
                  <TooltipTrigger className="inline-flex items-center gap-1.5 text-theme-muted/80 cursor-default outline-none">
                    <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="font-semibold">
                      {m.dashboard_reading_progress({ progress: repo.progress })}
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup side="top" className="bg-theme-surface text-theme-foreground border border-theme-border font-mono text-xs px-2.5 py-1 rounded-lg shadow-sm z-50">
                    {`${m.nav_reading_progress()}: ${repo.progress}%`}
                  </TooltipPopup>
                </Tooltip>
              </div>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenDetail(repo);
                }}
                className="absolute right-0 flex items-center gap-1 text-xs text-theme-muted group-hover:text-theme-foreground transition-opacity duration-150 font-medium opacity-0 group-hover:opacity-100 cursor-pointer whitespace-nowrap"
              >
                <span className="hidden sm:inline">{m.common_details()}</span>
                <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenDetail(repo);
              }}
              className="flex items-center gap-1 text-xs text-theme-muted group-hover:text-theme-foreground transition-opacity duration-150 font-medium opacity-0 group-hover:opacity-100 cursor-pointer"
            >
              <span className="hidden sm:inline">{m.common_details()}</span>
              <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
            </button>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
