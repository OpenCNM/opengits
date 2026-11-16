'use client';

import React from 'react';
import { Search, Zap, X, CheckCircle2, Info, Compass } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DisplayRepo } from '@/lib/home-data';
import { DashboardSourceFilterPills } from './DashboardSourceFilterPills';
import { dissectSearchQuery, type DashboardSourceType } from '@/lib/search/smart-repo-search';
import * as m from '@/paraglide/messages';

interface DashboardSearchHubProps {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  onClearSearch: () => void;
  onSearchSubmit: (e?: React.FormEvent) => void;
  onImportSubmit: (e?: React.FormEvent) => void;
  sourceType: DashboardSourceType;
  onSelectSourceType: (type: DashboardSourceType) => void;
  sourceCounts: {
    all: number;
    github: number;
    webdoc: number;
  };
  matchedCount: number;
  matchedFirstRepo?: DisplayRepo | null;
}

export function DashboardSearchHub({
  searchQuery,
  setSearchQuery,
  onClearSearch,
  onSearchSubmit,
  onImportSubmit,
  sourceType,
  onSelectSourceType,
  sourceCounts,
  matchedCount,
  matchedFirstRepo,
}: DashboardSearchHubProps) {
  const dissected = React.useMemo(() => dissectSearchQuery(searchQuery), [searchQuery]);
  const isUrlLike = Boolean(
    dissected.isUrl || (dissected.candidateOwner && dissected.candidateRepo)
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      onClearSearch();
    }
  };

  return (
    <div className="space-y-3.5">
      {/* 1. Header Bar: Title & Intent Hint */}
      <div className="shrink-0 flex items-center justify-between pb-0.5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-theme-muted flex items-center gap-1.5">
          <Compass className="w-3.5 h-3.5 text-theme-foreground/80" />
          <span>{m.dashboard_public_tutorials()}</span>
          <span className="font-mono text-theme-muted/80">({sourceCounts.all})</span>
        </h2>
      </div>

      {/* 2. Main Search & Import Omnibox Form */}
      <form onSubmit={onSearchSubmit} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-theme-muted absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={m.dashboard_search_or_import_placeholder()}
            className="w-full h-10 pl-9 pr-9 bg-theme-bg border border-theme-border/80 rounded-lg text-xs font-sans text-theme-foreground outline-none focus:border-theme-primary transition-all placeholder:text-theme-muted/60"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={onClearSearch}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer"
              title={m.common_close()}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Dual Actions: Search Existing (Default) + Import New */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="submit"
            className="h-10 px-3.5 bg-theme-surface hover:bg-theme-surface/80 text-theme-foreground border border-theme-border/80 hover:border-theme-border font-medium text-xs font-sans rounded-lg transition-all shadow-none flex items-center gap-1.5 cursor-pointer"
          >
            <Search className="w-3.5 h-3.5 text-theme-muted" />
            <span>{m.dashboard_btn_search()}</span>
          </button>

          <button
            type="button"
            onClick={onImportSubmit}
            className={cn(
              'h-10 px-3.5 font-medium text-xs font-sans rounded-lg transition-all shadow-none flex items-center gap-1.5 cursor-pointer',
              isUrlLike
                ? 'bg-theme-primary/10 hover:bg-theme-primary/20 text-theme-foreground border border-theme-primary/30 ring-1 ring-theme-primary/10 font-medium'
                : 'bg-theme-surface/60 hover:bg-theme-surface text-theme-muted hover:text-theme-foreground border border-theme-border/60'
            )}
          >
            <Zap className={cn('w-3.5 h-3.5', isUrlLike ? 'text-theme-foreground fill-current' : '')} />
            <span>{m.dashboard_btn_import()}</span>
          </button>
        </div>
      </form>

      {/* 3. Smart Feedback Strip (URL Detection & Existing Match Indicator) */}
      {searchQuery.trim() && isUrlLike && (
        <div className="flex items-center gap-1.5 text-micro font-sans px-1">
          {matchedCount > 0 && matchedFirstRepo ? (
            <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>
                {m.dashboard_hint_matched_existing()} ({matchedFirstRepo.owner}/{matchedFirstRepo.repo})
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-theme-muted">
              <Info className="w-3.5 h-3.5 shrink-0" />
              <span>{m.dashboard_hint_not_found_can_import()}</span>
            </div>
          )}
        </div>
      )}

      {/* 4. Orthogonal Source Type Filter */}
      <div className="flex flex-wrap items-center gap-2.5 pt-0.5">
        <DashboardSourceFilterPills
          sourceType={sourceType}
          onSelectSourceType={onSelectSourceType}
          counts={sourceCounts}
        />
      </div>
    </div>
  );
}
