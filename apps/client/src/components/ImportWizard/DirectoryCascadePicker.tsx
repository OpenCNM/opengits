'use client';
import * as m from '@/paraglide/messages';

import React, { useState, useEffect, useRef } from 'react';
import { Folder, FolderOpen, ChevronRight, Check, Layers } from 'lucide-react';
import type { DirTreeNode } from '@/lib/dir-verdict';
import { ScrollArea } from '@/components/ui/scroll-area';

interface DirectoryCascadePickerProps {
  dirTree?: DirTreeNode[];
  selectedPrefix: string;
  onSelectPrefix: (prefix: string) => void;
  borderless?: boolean;
  className?: string;
  heightClass?: string;
  hideHeader?: boolean;
}

const DEFAULT_EXPANDED_DEPTH = 1;

export function DirectoryCascadePicker({
  dirTree = [],
  selectedPrefix,
  onSelectPrefix,
  borderless = false,
  className = '',
  heightClass = 'h-[280px] md:h-[300px]',
  hideHeader = false,
}: DirectoryCascadePickerProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const selectedRef = useRef<HTMLDivElement | HTMLButtonElement | null>(null);

  useEffect(() => {
    const initial = new Set<string>();
    const walk = (nodes: DirTreeNode[], currentDepth: number = 0) => {
      if (currentDepth > 15) return;
      for (const n of nodes) {
        if (n.depth <= DEFAULT_EXPANDED_DEPTH && n.children.length > 0) initial.add(n.path);
        walk(n.children, currentDepth + 1);
      }
    };
    walk(dirTree, 0);
    setExpanded(initial);
  }, [dirTree]);

  useEffect(() => {
    if (!selectedPrefix) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const parts = selectedPrefix.split('/').filter(Boolean);
      let acc = '';
      for (let i = 0; i < parts.length; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i];
        next.add(acc + '/');
      }
      return next;
    });
  }, [selectedPrefix]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (selectedRef.current) {
        selectedRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [selectedPrefix, expanded]);

  const toggleExpand = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNode = (node: DirTreeNode, depth: number): React.ReactNode => {
    const isExpanded = expanded.has(node.path);
    const isSelected = selectedPrefix === node.path;
    const hasChildren = node.children.length > 0;
    const isEmpty = node.totalFiles === 0 && (!node.children || node.children.length === 0);

    return (
      <div key={node.path}>
        <div
          ref={isSelected ? (el) => { selectedRef.current = el; } : undefined}
          role="button"
          tabIndex={0}
          onClick={() => toggleExpand(node.path)}
          onKeyDown={(e) => { if (e.key === 'Enter') toggleExpand(node.path); }}
          className={`group flex items-center gap-1.5 w-full text-left rounded-lg px-2 py-1.5 transition-all cursor-pointer border text-xs ${
            isSelected
              ? 'bg-theme-primary/10 border-theme-primary/40 text-theme-primary font-bold shadow-2xs'
              : 'border-transparent hover:bg-theme-bg hover:border-theme-border/50 text-theme-foreground'
          }`}
          style={{ paddingLeft: `${depth * 14 + 6}px` }}
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleExpand(node.path); }}
            aria-label={isExpanded ? m.common_collapse() : m.common_expand()}
            className={`shrink-0 flex items-center justify-center w-3.5 h-3.5 rounded transition-all ${
              hasChildren ? 'text-theme-muted hover:text-theme-primary cursor-pointer' : 'opacity-0 pointer-events-none'
            }`}
          >
            <ChevronRight size={12} className={`transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`} />
          </button>

          {isExpanded && hasChildren ? (
            <FolderOpen size={14} className="shrink-0 text-theme-primary" />
          ) : (
            <Folder size={14} className={`shrink-0 ${isSelected ? 'text-theme-primary' : isEmpty ? 'text-theme-muted/40' : 'text-theme-muted'}`} />
          )}

          <span className={`truncate text-xs font-mono min-w-0 ${isEmpty ? 'text-theme-muted/60' : ''}`}>
            {node.name}/
          </span>

          {isSelected && (
            <span className="shrink-0 flex items-center gap-1 text-compact font-sans font-bold text-theme-primary bg-theme-primary/15 border border-theme-primary/40 px-2 py-0.5 rounded-md shadow-2xs ml-auto">
              <Check size={11} />
              <span>{m.dir_cascade_current_target()}</span>
            </span>
          )}

          {!isSelected && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSelectPrefix(node.path);
              }}
              className="shrink-0 hidden group-hover:flex items-center gap-1 px-2 py-0.5 text-compact bg-theme-primary hover:opacity-90 text-theme-primary-fg font-sans font-medium rounded-md shadow-2xs cursor-pointer ml-auto transition-all"
            >
              <span>{m.dir_cascade_set_as_target()}</span>
            </button>
          )}
        </div>

        {isExpanded && hasChildren && (
          <div className="border-l border-theme-border/30 ml-[18px]">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`w-full h-full flex flex-col gap-2 font-sans text-xs text-left ${borderless ? '' : 'bg-theme-surface/90 border border-theme-border/70 rounded-xl p-3 shadow-2xs'} ${className}`}>
      {!hideHeader && (
        <div className="flex items-center justify-between border-b border-theme-border/40 pb-2">
          <div className="flex items-center gap-1.5 font-bold text-theme-foreground text-xs">
            <Layers size={13} className="text-theme-primary" />
            <span>{m.dir_cascade_repo_tree()}</span>
          </div>
          <span className="text-compact text-theme-muted">
            {m.dir_cascade_hover_hint()}
          </span>
        </div>
      )}

      <ScrollArea className={heightClass} scrollFade scrollbarGutter>
        <div className="flex flex-col gap-0.5 pr-1.5 py-0.5">
          <div
            ref={selectedPrefix === '' ? (el) => { selectedRef.current = el; } : undefined}
            className={`group flex items-center gap-2 w-full text-left rounded-lg px-2 py-1.5 transition-all border text-xs ${
              selectedPrefix === ''
                ? 'border-theme-primary/40 bg-theme-primary/10 text-theme-primary font-bold shadow-2xs'
                : 'border-theme-border/40 bg-theme-bg/60 text-theme-foreground hover:border-theme-primary/30'
            }`}
          >
            <Folder size={14} className="shrink-0 text-theme-primary" />
            <span className="font-mono text-xs">{m.scout_feedback_root_dir()}</span>

            {selectedPrefix === '' ? (
              <span className="shrink-0 flex items-center gap-1 text-compact font-sans font-bold text-theme-primary bg-theme-primary/15 border border-theme-primary/40 px-2 py-0.5 rounded-md shadow-2xs ml-auto">
                <Check size={11} />
                <span>{m.dir_cascade_current_target()}</span>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onSelectPrefix('')}
                className="shrink-0 hidden group-hover:flex items-center gap-1 px-2 py-0.5 text-compact bg-theme-primary hover:opacity-90 text-theme-primary-fg font-sans font-medium rounded-md shadow-2xs cursor-pointer ml-auto transition-all"
              >
                <span>{m.dir_cascade_set_as_target()}</span>
              </button>
            )}
          </div>

          {dirTree.length > 0 ? (
            dirTree.map((node) => renderNode(node, 0))
          ) : (
            <div className="text-theme-muted text-xs py-4 text-center">{m.dir_cascade_no_dirs()}</div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
