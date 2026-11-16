'use client';

import React, { type Dispatch, type SetStateAction } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import * as m from '@/paraglide/messages';

interface DashboardFeedPaginationProps {
  totalItems: number;
  currentPage: number;
  totalPages: number;
  pageSize: number;
  onPageChange: Dispatch<SetStateAction<number>>;
}

export function DashboardFeedPagination({
  totalItems,
  currentPage,
  totalPages,
  pageSize,
  onPageChange,
}: DashboardFeedPaginationProps) {
  return (
    <div className="pt-4 mt-2 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs font-sans">
      <div className="text-theme-muted text-xs font-mono">
        {m.dashboard_pagination_showing()} <span className="text-theme-foreground font-semibold">{(currentPage - 1) * pageSize + 1}</span> - <span className="text-theme-foreground font-semibold">{Math.min(currentPage * pageSize, totalItems)}</span> {m.dashboard_pagination_of()} <span className="text-theme-foreground font-semibold">{totalItems}</span> {m.dashboard_pagination_total_suffix()}
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            if (currentPage > 1) {
              onPageChange(prev => prev - 1);
            }
          }}
          disabled={currentPage <= 1}
          className="px-2.5 py-1 rounded-md border border-theme-border/80 bg-theme-bg hover:bg-theme-surface hover:border-theme-foreground/30 disabled:opacity-30 disabled:hover:bg-theme-bg disabled:hover:border-theme-border/80 text-theme-foreground font-sans text-xs font-medium transition-colors flex items-center gap-1 cursor-pointer disabled:cursor-not-allowed shadow-none"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          <span>{m.dashboard_prev_page()}</span>
        </button>

        <span className="px-2.5 py-1 rounded-md bg-theme-bg border border-theme-border/70 text-theme-muted font-mono text-xs">
          {currentPage} / {totalPages}
        </span>

        <button
          type="button"
          onClick={() => {
            if (currentPage < totalPages) {
              onPageChange(prev => prev + 1);
            }
          }}
          disabled={currentPage >= totalPages}
          className="px-2.5 py-1 rounded-md border border-theme-border/80 bg-theme-bg hover:bg-theme-surface hover:border-theme-foreground/30 disabled:opacity-30 disabled:hover:bg-theme-bg disabled:hover:border-theme-border/80 text-theme-foreground font-sans text-xs font-medium transition-colors flex items-center gap-1 cursor-pointer disabled:cursor-not-allowed shadow-none"
        >
          <span>{m.dashboard_next_page()}</span>
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
