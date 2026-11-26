import React from 'react';
import { cn } from '@/lib/utils';

interface HighlightMatchProps {
  text: string;
  query: string;
  className?: string;
  highlightClassName?: string;
}

export function HighlightMatch({
  text,
  query,
  className,
  highlightClassName,
}: HighlightMatchProps) {
  if (!text) return null;
  const trimmed = query.trim();
  if (!trimmed) {
    return <span className={className}>{text}</span>;
  }

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));

  return (
    <span className={className}>
      {parts.map((part, i) =>
        part.toLowerCase() === trimmed.toLowerCase() ? (
          <span
            key={i}
            className={cn(
              'text-theme-foreground font-semibold bg-theme-foreground/10 px-0.5 rounded-[2px]',
              highlightClassName
            )}
          >
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
}
