'use client';

import { useState, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import * as m from '@/paraglide/messages';

interface EditorHeaderBarProps {
  chapterCount: number;
  lessonCount?: number;
  canUndoReorganize?: boolean;
  onUndoReorganize?: () => void;
  canResetToOriginal?: boolean;
  onResetToOriginal?: () => void;
  lastSavedTime?: number | null;
  directoryPicker?: ReactNode;
}

export function EditorHeaderBar({
  chapterCount,
  canUndoReorganize = false,
  onUndoReorganize,
  canResetToOriginal = false,
  onResetToOriginal,
  lastSavedTime,
  directoryPicker,
}: EditorHeaderBarProps) {
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const handleConfirmReset = () => {
    setShowResetConfirm(false);
    onResetToOriginal?.();
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3 shrink-0 pb-3 border-b border-theme-border/50">
        <div className="flex flex-wrap items-center gap-3">
          <h4 className="text-sm font-serif font-bold text-theme-foreground flex items-center gap-2">
            <span>{m.workbench_editor_title()}</span>
          </h4>
          <span className="inline-flex items-center gap-2 text-xs font-mono text-theme-muted px-3 py-0.5 rounded-full bg-theme-surface border border-theme-border/60">
            <span>
              <strong>{chapterCount}</strong> {m.dashboard_chapter()}
            </span>
          </span>

          {lastSavedTime && (
            <span className="text-xs text-theme-muted/70 font-sans select-none animate-in fade-in duration-300">
              {m.workbench_draft_saved()}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {directoryPicker}
          {canUndoReorganize && onUndoReorganize && (
            <button
              type="button"
              onClick={onUndoReorganize}
              className="px-2.5 py-1.5 text-xs font-sans font-medium border border-theme-border/70 bg-theme-surface/50 text-theme-muted hover:text-theme-foreground hover:border-theme-border rounded-lg transition-all cursor-pointer active:scale-95"
            >
              {m.workbench_reorganize_undo()}
            </button>
          )}

          {canResetToOriginal && (
            <button
              type="button"
              onClick={() => setShowResetConfirm(true)}
              className="px-2.5 py-1.5 text-xs font-serif font-medium border border-theme-border/70 text-theme-muted hover:text-amber-500 hover:border-amber-500/40 rounded-lg transition-all flex items-center gap-1.5 cursor-pointer"
              title={m.workbench_reset_tooltip()}
            >
              <RotateCcw size={13} />
              <span>{m.workbench_reset_btn()}</span>
            </button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={showResetConfirm}
        onOpenChange={setShowResetConfirm}
        title={m.workbench_reset_btn()}
        description={m.workbench_reset_confirm_desc()}
        confirmText={m.workbench_reset_confirm_btn()}
        cancelText={m.workbench_reset_cancel_btn()}
        onConfirm={handleConfirmReset}
      />
    </>
  );
}
