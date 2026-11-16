'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { ArrowDownUp, ChevronDown, Globe, Search, X } from 'lucide-react';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { DisplayRepo, EditionChip } from '@/lib/home-data';
import { DashboardCategoryChips } from './DashboardCategoryChips';
import { DashboardFeedCard } from './DashboardFeedCard';
import { DashboardFeedPagination } from './DashboardFeedPagination';
import { TutorialDetailDialog } from './TutorialDetailDialog';
import { requireApiKey } from '@/lib/api-key-guard';
import { GithubIcon } from '@/components/repo/RepoGithubOriginPopover';
import * as m from '@/paraglide/messages';
import type { DashboardFeedTab } from '../../hooks/useDashboardQueryParams';
import type { DashboardSourceType } from '@/lib/search/smart-repo-search';

interface DashboardFeedSectionProps {
  displayFeedRepos: DisplayRepo[];
  paginatedFeedRepos: DisplayRepo[];
  categories: string[];
  selectedCategory: string;
  setSelectedCategory: (cat: string) => void;
  currentSort: string;
  handleSortChange: (sort: string) => void;
  activeTab: DashboardFeedTab;
  setActiveTab: (tab: DashboardFeedTab) => void;
  totalItems: number;
  safeCurrentPage: number;
  totalPages: number;
  pageSize: number;
  setCurrentPage: React.Dispatch<React.SetStateAction<number>>;
  editionsOf: (repo: DisplayRepo) => EditionChip[] | undefined;
  followOverrides: Record<string, boolean>;
  handleToggleFollow: (repo: DisplayRepo, next: boolean) => Promise<void>;
  handleToggleSave: (repo: DisplayRepo) => void;
  setEditionDrawer: (drawer: { editions: EditionChip[]; owner: string; repo: string } | null) => void;
  setRelayTarget: (repo: DisplayRepo | null) => void;
  handleEditionSavedChange: (chip: EditionChip, isSaved: boolean) => void;
  openWizardForEdition: (owner: string, repo: string) => void;
  searchQuery?: string;
  onClearSearch?: () => void;
  sourceType?: DashboardSourceType;
  onClearSource?: () => void;
  highlightRepo?: string | null;
  onOpenDetail?: (repo: DisplayRepo) => void;
  onSearchTag?: (tag: string) => void;
}

export function DashboardFeedSection({
  displayFeedRepos,
  paginatedFeedRepos,
  categories,
  selectedCategory,
  setSelectedCategory,
  currentSort,
  handleSortChange,
  activeTab,
  setActiveTab,
  totalItems,
  safeCurrentPage,
  totalPages,
  pageSize,
  setCurrentPage,
  editionsOf,
  followOverrides,
  handleToggleFollow,
  handleToggleSave,
  setEditionDrawer,
  setRelayTarget,
  handleEditionSavedChange,
  openWizardForEdition,
  searchQuery = '',
  onClearSearch,
  onSearchTag,
  sourceType = 'all',
  onClearSource,
  highlightRepo = null,
  onOpenDetail: externalOpenDetail,
}: DashboardFeedSectionProps) {
  const router = useRouter();
  const [internalDetailRepo, setInternalDetailRepo] = useState<DisplayRepo | null>(null);
  const handleOpenDetail = externalOpenDetail ?? setInternalDetailRepo;

  const handledHighlightRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!highlightRepo || displayFeedRepos.length === 0) return;
    if (handledHighlightRef.current === highlightRepo) return;
    handledHighlightRef.current = highlightRepo;

    const target = highlightRepo.toLowerCase();
    const idx = displayFeedRepos.findIndex(
      (r) =>
        `${r.owner}/${r.repo}`.toLowerCase() === target ||
        r.repo.toLowerCase() === target ||
        r.id === highlightRepo
    );
    if (idx !== -1) {
      const targetPage = Math.floor(idx / pageSize) + 1;
      setCurrentPage(targetPage);
    }
  }, [highlightRepo, displayFeedRepos, pageSize, setCurrentPage]);

  const sortOptions = [
    { value: 'hot', label: m.filter_hottest() },
    { value: 'newest', label: m.filter_latest() },
    { value: 'oldest', label: m.filter_oldest() },
    { value: 'az', label: m.filter_az() },
    { value: 'za', label: m.filter_za() },
  ];

  return (
    <div className="space-y-4" id="feed-section">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-1">
        <div className="flex items-center gap-3 overflow-hidden">
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="font-bold text-base font-sans text-theme-foreground">
              {m.dashboard_public_tutorials()}
            </span>
            <span className="text-xs font-mono text-theme-muted">
              ({displayFeedRepos.length})
            </span>
          </div>

          <div className="h-3.5 w-px bg-theme-border/70 hidden sm:block shrink-0" />

          {/* Categories Inline Chips */}
          <DashboardCategoryChips
            categories={categories}
            selectedCategory={selectedCategory}
            onSelectCategory={setSelectedCategory}
          />

          {/* Search Query Filter Pill */}
          {searchQuery && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-theme-primary/10 border border-theme-primary/20 text-xs font-sans text-theme-primary shrink-0">
              <Search className="w-3 h-3 shrink-0" />
              <span className="font-medium truncate max-w-[120px] sm:max-w-[180px]">
                {m.dashboard_search_filter({ query: searchQuery })}
              </span>
              {onClearSearch && (
                <button
                  type="button"
                  onClick={onClearSearch}
                  className="p-0.5 hover:bg-theme-primary/20 rounded cursor-pointer transition-colors"
                  title={m.common_close()}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          )}

          {/* Active Source Filter Pill */}
          {sourceType && sourceType !== 'all' && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-theme-surface border border-theme-border/80 text-xs font-sans text-theme-foreground shrink-0">
              {sourceType === 'webdoc' ? (
                <Globe className="w-3.5 h-3.5 text-theme-foreground/80 shrink-0" />
              ) : (
                <GithubIcon className="w-3.5 h-3.5 text-theme-foreground/80 shrink-0" />
              )}
              <span>
                {sourceType === 'webdoc'
                  ? m.dashboard_source_webdoc()
                  : m.dashboard_source_github()}
              </span>
              {onClearSource && (
                <button
                  type="button"
                  onClick={onClearSource}
                  className="p-0.5 hover:bg-theme-muted/20 rounded cursor-pointer transition-colors"
                  title={m.common_close()}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Feed Controls: Sort Selector + Feed Tabs */}
        <div className="flex items-center gap-2 shrink-0 self-start sm:self-auto flex-wrap">
          {/* Sort Selector */}
          <Select
            value={currentSort}
            onValueChange={(val) => {
              if (val) handleSortChange(val);
            }}
          >
            <SelectTrigger
              aria-label={m.filter_sort_by()}
              icon={<ChevronDown className="w-3.5 h-3.5 text-theme-muted opacity-80 shrink-0 ml-0.5" />}
              className="h-7 min-h-0 sm:min-h-0 w-auto min-w-0 bg-transparent hover:bg-theme-surface rounded-md px-2 py-0.5 text-xs font-sans gap-1 shadow-none border-0 transition-colors cursor-pointer text-theme-muted hover:text-theme-foreground focus-visible:ring-0"
            >
              <div className="flex items-center gap-1.5">
                <ArrowDownUp className="w-3.5 h-3.5 text-theme-muted shrink-0" />
                <SelectValue>
                  {sortOptions.find((o) => o.value === currentSort)?.label || m.filter_hottest()}
                </SelectValue>
              </div>
            </SelectTrigger>
            <SelectContent
              alignItemWithTrigger={false}
              side="bottom"
              align="start"
              sideOffset={6}
              className="min-w-[120px] p-1 font-sans text-xs"
              containerClassName="rounded-lg border-theme-border/80 bg-theme-bg shadow-md"
            >
              {sortOptions.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  className="text-xs font-sans cursor-pointer rounded-md px-2 py-1 text-theme-foreground data-highlighted:bg-theme-surface transition-colors"
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Feed Tabs: Ghost Segmented Control (macOS / Raycast Style) */}
          <div className="flex items-center gap-0.5 bg-theme-surface/70 dark:bg-theme-surface/50 p-0.5 rounded-lg text-xs shrink-0 relative">
            <button
              type="button"
              onClick={() => {
                setActiveTab('all');
                const params = new URLSearchParams(window.location.search);
                params.delete('tab');
                const qs = params.toString();
                router.replace(qs ? `/?${qs}` : '/', { scroll: false });
              }}
              className={`relative px-2.5 py-1 rounded-md transition-colors cursor-pointer font-sans text-xs select-none z-10 ${
                activeTab === 'all'
                  ? 'text-theme-foreground font-medium'
                  : 'text-theme-muted hover:text-theme-foreground'
              }`}
            >
              {activeTab === 'all' && (
                <motion.div
                  layoutId="dashboard-feed-tab-active"
                  className="absolute inset-0 bg-theme-bg rounded-md -z-10 shadow-sm"
                  transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                />
              )}
              {m.dashboard_latest_tutorials()}
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveTab('trending');
                const params = new URLSearchParams(window.location.search);
                params.set('tab', 'trending');
                router.replace(`/?${params.toString()}`, { scroll: false });
              }}
              className={`relative px-2.5 py-1 rounded-md transition-colors cursor-pointer font-sans text-xs select-none z-10 ${
                activeTab === 'trending'
                  ? 'text-theme-foreground font-medium'
                  : 'text-theme-muted hover:text-theme-foreground'
              }`}
            >
              {activeTab === 'trending' && (
                <motion.div
                  layoutId="dashboard-feed-tab-active"
                  className="absolute inset-0 bg-theme-bg rounded-md -z-10 shadow-sm"
                  transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                />
              )}
              {m.filter_recommend()}
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveTab('review');
                const params = new URLSearchParams(window.location.search);
                params.set('tab', 'review');
                router.replace(`/?${params.toString()}`, { scroll: false });
              }}
              className={`relative px-2.5 py-1 rounded-md transition-colors cursor-pointer font-sans text-xs select-none z-10 ${
                activeTab === 'review'
                  ? 'text-theme-foreground font-medium'
                  : 'text-theme-muted hover:text-theme-foreground'
              }`}
            >
              {activeTab === 'review' && (
                <motion.div
                  layoutId="dashboard-feed-tab-active"
                  className="absolute inset-0 bg-theme-bg rounded-md -z-10 shadow-sm"
                  transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                />
              )}
              {m.dashboard_join_relay()}
            </button>
          </div>
        </div>
      </div>

      {/* 🌟 2-Column Responsive Bento Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 min-h-[640px] content-start">
        <AnimatePresence mode="popLayout">
          {paginatedFeedRepos.length === 0 ? (
            <div className="col-span-full p-8 rounded-xl border border-dashed border-theme-border/70 bg-theme-bg text-center space-y-2">
              <p className="text-xs text-theme-muted font-mono">{m.empty_no_matches()}</p>
            </div>
          ) : (
            paginatedFeedRepos.map((repo) => {
              const isHighlighted = Boolean(
                highlightRepo &&
                  (`${repo.owner}/${repo.repo}`.toLowerCase() === highlightRepo.toLowerCase() ||
                    repo.repo.toLowerCase() === highlightRepo.toLowerCase() ||
                    repo.id === highlightRepo)
              );
              return (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15, ease: 'easeOut' }}
                  key={repo.id}
                  onClick={() => handleOpenDetail(repo)}
                  className={cn(
                    'group p-4 sm:p-5 rounded-xl border bg-theme-bg hover:border-theme-foreground/30 transition-colors flex flex-col justify-between space-y-3 cursor-pointer shadow-none min-h-[148px]',
                    isHighlighted
                      ? 'border-theme-primary ring-1 ring-theme-primary/30 bg-theme-primary/[0.02]'
                      : 'border-theme-border/80 hover:border-theme-foreground/30'
                  )}
                >
                  <DashboardFeedCard
                    repo={repo}
                    editions={editionsOf(repo)}
                    followOn={followOverrides[repo.id] ?? (repo.autoFollow ?? true)}
                    onToggleFollow={handleToggleFollow}
                    onToggleSave={handleToggleSave}
                    onOpenEditionDrawer={setEditionDrawer}
                    onOpenRelayWorkbench={setRelayTarget}
                    onEditionSavedChange={handleEditionSavedChange}
                    onCreateEdition={() => requireApiKey(() => openWizardForEdition(repo.owner, repo.repo))}
                    onOpenDetail={handleOpenDetail}
                    onSearchTag={onSearchTag}
                    isHighlighted={isHighlighted}
                  />
                </motion.div>
              );
            })
          )}
        </AnimatePresence>
      </div>

      {/* 🌟 Feed Pagination Bar */}
      {totalItems > 0 && (
        <DashboardFeedPagination
          totalItems={totalItems}
          currentPage={safeCurrentPage}
          totalPages={totalPages}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
        />
      )}

      {/* 🌟 教程详情全局弹窗（外部未接管时作为独立回落） */}
      {!externalOpenDetail && (
        <TutorialDetailDialog
          repo={internalDetailRepo}
          open={Boolean(internalDetailRepo)}
          onOpenChange={(open) => !open && setInternalDetailRepo(null)}
          editions={internalDetailRepo ? editionsOf(internalDetailRepo) : undefined}
          canManage={internalDetailRepo ? Boolean(internalDetailRepo.canManage || internalDetailRepo.isMaintainer) : false}
          onEditionSavedChange={handleEditionSavedChange}
          onCreateEdition={(owner, repo) => requireApiKey(() => openWizardForEdition(owner, repo))}
          onToggleSave={handleToggleSave}
          onSelectTab={setActiveTab}
          onSearchTag={onSearchTag}
          onOpenRelayWorkbench={(targetRepo) => {
            setInternalDetailRepo(null);
            setRelayTarget?.(targetRepo);
          }}
        />
      )}
    </div>
  );
}
