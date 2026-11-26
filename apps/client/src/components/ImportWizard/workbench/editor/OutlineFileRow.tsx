'use client';

import React from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverPopup } from '@/components/ui/popover';
import * as m from '@/paraglide/messages';

export interface WorkbenchOutlineFile {
  path?: string;
  shortTitle?: string;
  anchor?: string;
  kind?: string;
  companionFiles?: string[];
}

export function getFileBadge(file: WorkbenchOutlineFile): { label: string; className: string } {
  if (file.kind) {
    const k = file.kind.toLowerCase();
    if (k === 'function') {
      return {
        label: 'FN',
        className: 'text-sky-600 bg-sky-500/10 border-sky-500/30 dark:text-sky-400',
      };
    }
    if (k === 'method') {
      return {
        label: 'MT',
        className: 'text-indigo-600 bg-indigo-500/10 border-indigo-500/30 dark:text-indigo-400',
      };
    }
    if (k === 'type' || k === 'interface' || k === 'class' || k === 'struct') {
      return {
        label: 'TY',
        className: 'text-emerald-600 bg-emerald-500/10 border-emerald-500/30 dark:text-emerald-400',
      };
    }
    if (k === 'heading') {
      return {
        label: 'HD',
        className: 'text-amber-600 bg-amber-500/10 border-amber-500/30 dark:text-amber-400',
      };
    }
    if (k === 'spec' || k === 'test') {
      return {
        label: 'TC',
        className: 'text-purple-600 bg-purple-500/10 border-purple-500/30 dark:text-purple-400',
      };
    }
  }

  const p = file.path || '';
  const ext = p.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'ts':
    case 'tsx':
      return {
        label: 'TS',
        className: 'text-blue-600 bg-blue-500/10 border-blue-500/30 dark:text-blue-400',
      };
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return {
        label: 'JS',
        className: 'text-yellow-600 bg-yellow-500/10 border-yellow-500/30 dark:text-yellow-400',
      };
    case 'go':
      return {
        label: 'GO',
        className: 'text-cyan-600 bg-cyan-500/10 border-cyan-500/30 dark:text-cyan-400',
      };
    case 'py':
      return {
        label: 'PY',
        className: 'text-blue-500 bg-blue-500/10 border-blue-500/30 dark:text-blue-300',
      };
    case 'rs':
      return {
        label: 'RS',
        className: 'text-orange-600 bg-orange-500/10 border-orange-500/30 dark:text-orange-400',
      };
    case 'md':
    case 'mdx':
      return {
        label: 'MD',
        className: 'text-theme-muted bg-theme-surface border-theme-border/60',
      };
    case 'json':
      return {
        label: 'JSON',
        className: 'text-amber-500 bg-amber-500/10 border-amber-500/30 dark:text-amber-300',
      };
    default:
      return {
        label: ext ? ext.slice(0, 3).toUpperCase() : 'DOC',
        className: 'text-theme-muted bg-theme-surface border-theme-border/60',
      };
  }
}

interface OutlineFileRowProps {
  file: WorkbenchOutlineFile;
  catIndex: number;
  fileIndex: number;
  isTranslating: boolean;
  isEditing: boolean;
  onSetEditingFileKey: (key: string | null) => void;
  onUpdateFileShortTitle: (catIndex: number, fileIndex: number, title: string) => void;
  onDeleteFile: (catIndex: number, fileIndex: number) => void;
  onDragStart: (e: React.DragEvent, catIndex: number, fileIndex: number) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, catIndex: number, fileIndex: number) => void;
}

export function OutlineFileRow({
  file,
  catIndex,
  fileIndex,
  isTranslating,
  isEditing,
  onSetEditingFileKey,
  onUpdateFileShortTitle,
  onDeleteFile,
  onDragStart,
  onDragOver,
  onDrop,
}: OutlineFileRowProps) {
  const fileKey = `${catIndex}-${fileIndex}`;
  const badge = getFileBadge(file);
  const rawFileName = file.path?.split('/').pop() || '';
  const baseName = rawFileName.replace(/\.[^/.]+$/, '');
  const hasAnchor = Boolean(file.anchor);
  const isGenericTitle =
    !file.shortTitle ||
    file.shortTitle.toLowerCase() === 'index' ||
    file.shortTitle.toLowerCase() === baseName.toLowerCase();

  const displayTitle =
    isGenericTitle && hasAnchor
      ? file.anchor
      : file.shortTitle || file.anchor || rawFileName || m.workbench_editor_untitled_lesson();

  const displayPath = file.anchor ? `${file.path || ''}#${file.anchor}` : file.path || '';
  const companionCount = file.companionFiles?.length ?? 0;

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, catIndex, fileIndex)}
      onDragOver={onDragOver}
      onDrop={(e) => onDrop(e, catIndex, fileIndex)}
      className="flex items-center gap-2 p-2 rounded-lg border border-theme-border/60 bg-theme-bg hover:border-theme-foreground/60 transition-all group/file text-xs min-w-0 overflow-hidden"
    >
      <span
        className={`text-micro font-mono px-1 rounded border shrink-0 ${badge.className}`}
        title={file.kind ? `Symbol Kind: ${file.kind}` : undefined}
      >
        {badge.label}
      </span>

      {isEditing ? (
        <input
          type="text"
          autoFocus
          value={file.shortTitle || displayTitle}
          onChange={(e) => onUpdateFileShortTitle(catIndex, fileIndex, e.target.value)}
          onBlur={() => onSetEditingFileKey(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') onSetEditingFileKey(null);
          }}
          className={`font-serif flex-1 min-w-0 bg-theme-surface/80 px-2 py-0.5 rounded border border-theme-border text-theme-foreground outline-none ${
            isTranslating ? 'animate-pulse text-theme-primary font-bold' : ''
          }`}
        />
      ) : (
        <span
          onDoubleClick={() => onSetEditingFileKey(fileKey)}
          className={`font-serif flex-1 min-w-0 cursor-pointer select-none truncate ${
            isTranslating ? 'animate-pulse text-theme-primary font-bold' : 'text-theme-foreground'
          }`}
          title={m.workbench_editor_file_title_hint()}
        >
          {displayTitle}
        </span>
      )}

      {companionCount > 0 && (
        <Popover>
          <PopoverTrigger
            type="button"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-micro font-mono bg-theme-surface border border-theme-border/80 text-theme-muted hover:text-theme-foreground hover:border-theme-border cursor-pointer transition-colors select-none"
            title={`${m.workbench_companion_files()}${companionCount})`}
          >
            <span>+{companionCount}</span>
          </PopoverTrigger>
          <PopoverPopup
            side="top"
            align="end"
            sideOffset={6}
            className="w-80 max-w-[90vw] p-3 text-xs bg-theme-surface border border-theme-border rounded-xl shadow-xl z-[250]"
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-semibold text-theme-foreground">
                {m.workbench_companion_files()}{companionCount})
              </span>
              <span className="text-micro font-mono text-theme-muted px-1.5 py-0.5 rounded bg-theme-bg border border-theme-border/60">
                {m.workbench_companion_context_injected()}
              </span>
            </div>
            <p className="text-micro text-theme-muted mb-2 leading-relaxed">
              {m.workbench_companion_hint()}
            </p>
            <div className="max-h-48 overflow-y-auto space-y-1 font-mono text-micro divide-y divide-theme-border/20 pr-1">
              {file.companionFiles?.map((compPath) => (
                <div
                  key={compPath}
                  className="pt-1 first:pt-0 truncate text-theme-secondary hover:text-theme-foreground transition-colors"
                  title={compPath}
                >
                  {compPath}
                </div>
              ))}
            </div>
          </PopoverPopup>
        </Popover>
      )}

      <span className="text-xs font-mono text-theme-muted truncate max-w-[160px] md:max-w-[200px] shrink-0" title={displayPath}>
        {displayPath}
      </span>

      <div className="flex items-center gap-1 opacity-0 group-hover/file:opacity-100 transition-opacity shrink-0">
        <button
          type="button"
          onClick={() => onSetEditingFileKey(fileKey)}
          className="p-1 text-theme-muted hover:text-theme-primary transition-colors cursor-pointer"
          title={m.workbench_editor_edit_file_title()}
        >
          <Pencil size={12} />
        </button>
        <button
          type="button"
          onClick={() => onDeleteFile(catIndex, fileIndex)}
          className="p-1 text-theme-muted hover:text-rose-600 transition-colors cursor-pointer"
          title={m.workbench_editor_remove_file()}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}
