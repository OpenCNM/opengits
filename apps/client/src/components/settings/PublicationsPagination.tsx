'use client';

import React from 'react';
import * as m from '@/paraglide/messages';
import { cn } from '@/lib/utils';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';

export interface PublicationsPaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}

/**
 * 7-Item 稳定分页序列生成算法（含省略符）
 */
export function generatePaginationPages(
  currentPage: number,
  totalPages: number
): Array<number | 'ellipsis'> {
  if (totalPages <= 0) return [];
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages: Array<number | 'ellipsis'> = [1];

  if (currentPage <= 4) {
    for (let i = 2; i <= 5; i++) {
      pages.push(i);
    }
    pages.push('ellipsis');
    pages.push(totalPages);
  } else if (currentPage >= totalPages - 3) {
    pages.push('ellipsis');
    for (let i = totalPages - 4; i <= totalPages; i++) {
      pages.push(i);
    }
  } else {
    pages.push('ellipsis');
    pages.push(currentPage - 1);
    pages.push(currentPage);
    pages.push(currentPage + 1);
    pages.push('ellipsis');
    pages.push(totalPages);
  }

  return pages;
}

export function PublicationsPagination({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
}: PublicationsPaginationProps) {
  if (totalPages <= 1) return null;

  const pages = generatePaginationPages(currentPage, totalPages);
  const startItem = (currentPage - 1) * pageSize + 1;
  const endItem = Math.min(currentPage * pageSize, totalItems);

  return (
    <div className="pt-4 mt-2 flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-theme-border/40 select-none">
      {/* 左侧：条目计数与当前区间 */}
      <div className="text-theme-muted text-xs font-mono">
        {m.dashboard_pagination_showing()}{' '}
        <span className="text-theme-foreground font-semibold">{startItem}</span> -{' '}
        <span className="text-theme-foreground font-semibold">{endItem}</span>{' '}
        {m.dashboard_pagination_of()}{' '}
        <span className="text-theme-foreground font-semibold">{totalItems}</span>{' '}
        {m.dashboard_pagination_total_suffix()}
      </div>

      {/* 右侧：Coss UI 原生风格分页导航 */}
      <Pagination className="w-auto mx-0 justify-end">
        <PaginationContent className="gap-1">
          <PaginationItem>
            <PaginationPrevious
              onClick={(e) => {
                e.preventDefault();
                if (currentPage > 1) {
                  onPageChange(currentPage - 1);
                }
              }}
              tabIndex={currentPage <= 1 ? -1 : 0}
              aria-disabled={currentPage <= 1}
              className={cn(
                'cursor-pointer text-xs h-8 px-2.5 rounded-lg border border-theme-border/70 transition-colors',
                currentPage <= 1
                  ? 'pointer-events-none opacity-40'
                  : 'hover:bg-theme-surface hover:text-theme-foreground'
              )}
            />
          </PaginationItem>

          {pages.map((p, idx) => {
            if (p === 'ellipsis') {
              return (
                <PaginationItem key={`ellipsis-${idx}`}>
                  <PaginationEllipsis className="text-theme-muted" />
                </PaginationItem>
              );
            }

            const isActive = currentPage === p;
            return (
              <PaginationItem key={p}>
                <PaginationLink
                  onClick={(e) => {
                    e.preventDefault();
                    onPageChange(p);
                  }}
                  isActive={isActive}
                  className={cn(
                    'cursor-pointer text-xs h-8 min-w-8 px-2 rounded-lg font-mono transition-all',
                    isActive
                      ? 'bg-theme-bg text-theme-foreground font-semibold shadow-2xs border border-theme-border'
                      : 'text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/50 border border-transparent'
                  )}
                >
                  {p}
                </PaginationLink>
              </PaginationItem>
            );
          })}

          <PaginationItem>
            <PaginationNext
              onClick={(e) => {
                e.preventDefault();
                if (currentPage < totalPages) {
                  onPageChange(currentPage + 1);
                }
              }}
              tabIndex={currentPage >= totalPages ? -1 : 0}
              aria-disabled={currentPage >= totalPages}
              className={cn(
                'cursor-pointer text-xs h-8 px-2.5 rounded-lg border border-theme-border/70 transition-colors',
                currentPage >= totalPages
                  ? 'pointer-events-none opacity-40'
                  : 'hover:bg-theme-surface hover:text-theme-foreground'
              )}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
