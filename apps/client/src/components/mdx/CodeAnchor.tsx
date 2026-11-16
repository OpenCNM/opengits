'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { FileCode } from 'lucide-react';
import { useCodeDrawerStore } from '@/lib/stores/code-drawer-store';
import { parseCodeAnchor, formatCodeAnchor } from '@/lib/code-viewport/line-anchor';
import { cn } from '@/lib/utils';
import * as m from '@/paraglide/messages';

export interface CodeAnchorProps {
  file?: string;
  lines?: string;
  symbol?: string;
  href?: string;
  children?: React.ReactNode;
  className?: string;
}

export function CodeAnchor({
  file,
  lines,
  symbol,
  href,
  children,
  className,
}: CodeAnchorProps) {
  const params = useParams<{ owner?: string; repo?: string }>();
  const owner = params?.owner;
  const repo = params?.repo;

  // 1. 从 props 或 href 中解析正典目标
  let targetFile = file?.replace(/^\.?\//, '').trim() || '';
  let startLine: number | undefined = undefined;
  let endLine: number | undefined = undefined;

  if (href) {
    const parsed = parseCodeAnchor(href);
    if (parsed) {
      if (parsed.filePath) targetFile = parsed.filePath;
      startLine = parsed.range.startLine;
      endLine = parsed.range.endLine;
    }
  }

  if (lines && (!startLine || !endLine)) {
    const lineParts = lines.replace(/^L/i, '').split(/[-:]/);
    const start = parseInt(lineParts[0], 10);
    if (!Number.isNaN(start) && start > 0) {
      startLine = start;
      const end = lineParts[1] ? parseInt(lineParts[1].replace(/^L/i, ''), 10) : start;
      endLine = Number.isNaN(end) || end <= 0 ? start : end;
    }
  }

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!targetFile && !lines && !symbol) return;

    // A. 优先查找当前页面内已有的同文件代码视口
    if (targetFile && typeof document !== 'undefined') {
      const escaped = CSS.escape(targetFile);
      const inPageBlock =
        document.querySelector<HTMLElement>(`[data-filename*="${escaped}"]`) ||
        document.querySelector<HTMLElement>(`[data-title*="${escaped}"]`);

      if (inPageBlock) {
        inPageBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const nextHash = formatCodeAnchor({
          filePath: targetFile,
          startLine: startLine || 1,
          endLine,
          symbol,
        });
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${nextHash}`);
        window.dispatchEvent(new Event('hashchange'));
        return;
      }
    }

    // B. 若不在当前页面渲染，呼出 CodeDrawer 零物化侧边视口
    if (owner && repo && targetFile) {
      useCodeDrawerStore.getState().openDrawer({
        owner,
        repo,
        filePath: targetFile,
        startLine,
        endLine,
        symbol,
      });
    }
  };

  const displayLines =
    startLine !== undefined
      ? `L${startLine}${endLine && endLine !== startLine ? `-L${endLine}` : ''}`
      : lines;

  return (
    <span
      onClick={handleClick}
      role="button"
      tabIndex={0}
      title={m.code_anchor_locate_title({ target: `${targetFile || symbol || ''}${displayLines ? ` :${displayLines}` : ''}` })}
      className={cn(
        'inline-flex items-center gap-1 font-mono text-xs px-1.5 py-0.5 rounded border border-theme-border/80 bg-theme-surface/70 text-theme-foreground hover:text-theme-primary hover:border-theme-primary/40 hover:bg-theme-bg transition-colors cursor-pointer group mx-0.5 select-none align-baseline',
        className
      )}
    >
      <FileCode className="w-3 h-3 text-theme-primary shrink-0 opacity-70 group-hover:opacity-100 transition-opacity" />
      <span className="underline decoration-theme-border/60 group-hover:decoration-theme-primary/60 underline-offset-2">
        {children || symbol || targetFile}
      </span>
      {displayLines && (
        <span className="text-micro text-theme-muted group-hover:text-theme-primary transition-colors">
          :{displayLines}
        </span>
      )}
    </span>
  );
}
