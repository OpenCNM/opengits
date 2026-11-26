'use client';

import React from 'react';
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

export interface ExplorePaginationProps {
 currentPage: number;
 totalPages: number;
 totalCount?: number;
 onPageChange: (page: number) => void;
}

export function ExplorePagination({
 currentPage,
 totalPages,
 totalCount,
 onPageChange,
}: ExplorePaginationProps) {
 if (totalPages <= 0) return null;

 const pages: Array<number | 'ellipsis'> = [];
 if (totalPages <= 7) {
 for (let i = 1; i <= totalPages; i++) pages.push(i);
 } else {
 pages.push(1);
 if (currentPage > 3) pages.push('ellipsis');

 const start = Math.max(2, currentPage - 1);
 const end = Math.min(totalPages - 1, currentPage + 1);
 for (let i = start; i <= end; i++) pages.push(i);

 if (currentPage < totalPages - 2) pages.push('ellipsis');
 pages.push(totalPages);
 }

 return (
 <div className="w-full my-8 select-none">
 <Pagination>
 <PaginationContent>
 <PaginationItem>
 <PaginationPrevious
 onClick={(e) => {
 e.preventDefault();
 if (currentPage > 1) onPageChange(currentPage - 1);
 }}
 className={cn(
 'cursor-pointer',
 currentPage === 1 && 'pointer-events-none opacity-50'
 )}
 >
 {""}
 </PaginationPrevious>
 </PaginationItem>

 {pages.map((p, idx) => {
 if (p === 'ellipsis') {
 return (
 <PaginationItem key={`ellipsis-${idx}`}>
 <PaginationEllipsis />
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
 "cursor-pointer font-serif text-xs transition-all",
 isActive
 ? "bg-theme-bg/60 text-theme-foreground font-bold border border-theme-border/60 shadow-none"
 : "text-theme-muted hover:text-theme-foreground hover:bg-theme-bg/30 border border-transparent"
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
 if (currentPage < totalPages) onPageChange(currentPage + 1);
 }}
 className={cn(
 'cursor-pointer',
 currentPage === totalPages && 'pointer-events-none opacity-50'
 )}
 >
 {""}
 </PaginationNext>
 </PaginationItem>
 </PaginationContent>
 </Pagination>
 </div>
 );
}
