import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import * as m from '@/paraglide/messages';
import { cn } from '@/lib/utils';

export interface ChapterNavLink {
  title: string;
  url: string;
}

export interface ChapterPrevNextNavProps {
  prev: ChapterNavLink | null;
  next: ChapterNavLink | null;
}

/**
 * 正文底部的上一章/下一章导航（教学顺序）。
 * 两侧都缺失时不渲染；单侧缺失保留占位以保持左右布局对齐。
 */
export function ChapterPrevNextNav({ prev, next }: ChapterPrevNextNavProps) {
  if (!prev && !next) return null;

  return (
    <nav
      aria-label={m.dashboard_chapter()}
      className="mt-10 pt-6 border-t border-theme-border/60 grid grid-cols-1 sm:grid-cols-2 gap-3"
    >
      {prev ? (
        <Link
          href={prev.url}
          className="group flex items-center gap-2.5 px-4 py-3 rounded-xl border border-theme-border/70 bg-theme-surface/40 hover:border-theme-primary/50 hover:bg-theme-surface transition-colors text-left"
        >
          <ChevronLeft className="w-4 h-4 text-theme-muted shrink-0 group-hover:text-theme-primary transition-colors" />
          <span className="min-w-0">
            <span className="block text-micro text-theme-muted font-mono">{m.docs_prev_chapter()}</span>
            <span className="block text-sm text-theme-foreground truncate group-hover:text-theme-primary transition-colors">
              {prev.title}
            </span>
          </span>
        </Link>
      ) : (
        <span className="hidden sm:block" aria-hidden />
      )}
      {next ? (
        <Link
          href={next.url}
          className={cn(
            'group flex items-center justify-end gap-2.5 px-4 py-3 rounded-xl border border-theme-border/70 bg-theme-surface/40',
            'hover:border-theme-primary/50 hover:bg-theme-surface transition-colors text-right',
            !prev && 'sm:col-start-2'
          )}
        >
          <span className="min-w-0">
            <span className="block text-micro text-theme-muted font-mono">{m.docs_next_chapter()}</span>
            <span className="block text-sm text-theme-foreground truncate group-hover:text-theme-primary transition-colors">
              {next.title}
            </span>
          </span>
          <ChevronRight className="w-4 h-4 text-theme-muted shrink-0 group-hover:text-theme-primary transition-colors" />
        </Link>
      ) : null}
    </nav>
  );
}
