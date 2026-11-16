'use client';
import * as m from '@/paraglide/messages';

import { ThumbsUp } from 'lucide-react';

import { useHelpfulVote } from '../hooks/useHelpfulVote';

/** 「有帮助」按钮（推荐分社区认可信号；一人一票 toggle） */
export function HelpfulNavButton({
  owner,
  repo,
  initialCount,
  initialVoted,
}: {
  owner: string;
  repo: string;
  initialCount: number;
  initialVoted: boolean;
}) {
  const { count, voted, busy, toggle } = useHelpfulVote({
    owner,
    repo,
    initialCount,
    initialVoted,
  });

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-serif border transition-all cursor-pointer disabled:opacity-50 ${
        voted
          ? 'bg-theme-primary/10 border-theme-primary/40 text-theme-primary'
          : 'border-transparent text-theme-muted hover:text-theme-foreground hover:border-theme-border'
      }`}
      title={voted ? m.reader_helpful_voted_title() : m.reader_helpful_ask_title()}
    >
      <ThumbsUp className={`w-3.5 h-3.5 ${voted ? 'fill-theme-primary/20' : ''}`} />
      {m.reader_helpful()}
      {count > 0 ? ` ${count}` : ''}
    </button>
  );
}
