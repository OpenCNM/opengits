'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, FolderTree, Info, RotateCcw, Sparkles } from 'lucide-react';
import * as m from '@/paraglide/messages';
import type { DirTreeNode } from '@/lib/dir-verdict';
import { useImportWizardStore, wizardSetters } from '@/lib/stores/import-wizard-store';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { DirectoryCascadePicker } from '../DirectoryCascadePicker';

interface WorkbenchDirectoryPickerProps {
  disabled?: boolean;
  onDirectoryApplied?: () => void;
}

export function WorkbenchDirectoryPicker({
  disabled = false,
  onDirectoryApplied,
}: WorkbenchDirectoryPickerProps) {
  const scoutData = useImportWizardStore((s) => s.scoutData);
  const selectedPrefix = useImportWizardStore((s) => s.selectedPrefix);
  const recommendedPrefix = useImportWizardStore((s) => s.recommendedPrefix);
  const autoPruneAuxiliary = useImportWizardStore((s) => s.autoPruneAuxiliary);
  const excludedPaths = useImportWizardStore((s) => s.excludedPaths);

  const [open, setOpen] = useState(false);
  const [pendingPrefix, setPendingPrefix] = useState(selectedPrefix);
  const [pendingAutoPrune, setPendingAutoPrune] = useState(autoPruneAuxiliary);

  useEffect(() => {
    if (open) {
      setPendingPrefix(selectedPrefix);
      setPendingAutoPrune(autoPruneAuxiliary);
    }
  }, [open, selectedPrefix, autoPruneAuxiliary]);

  const dirTree: DirTreeNode[] = Array.isArray(scoutData?.dirTree) ? scoutData.dirTree : [];
  const scopeVerdict = (scoutData?.scopeVerdict ?? null) as
    | { targetRoot?: string; auxiliaryPaths?: string[]; rationale?: string }
    | null;
  const ratio = (scoutData as any)?.profile?.docCodeRatio;
  const totalFiles: number = ratio
    ? (ratio.totalFiles || (ratio.docFiles || 0) + (ratio.codeFiles || 0))
    : ((scoutData as any)?.fileCount || 0);
  const isLargeRepo = totalFiles >= 200;

  const auxiliaryCandidates = useMemo(() => {
    const auxPaths: string[] = Array.isArray(scopeVerdict?.auxiliaryPaths)
      ? scopeVerdict.auxiliaryPaths
      : [];
    if (auxPaths.length === 0 || dirTree.length === 0) return [];
    const auxSet = new Set(auxPaths);
    const cleanPrefix = pendingPrefix.trim().replace(/^\/|\/$/g, '');
    const candidates = !cleanPrefix
      ? dirTree.filter((n) => n.depth === 1)
      : (() => {
          const current = dirTree.find((n) => n.path.replace(/^\/|\/$/g, '') === cleanPrefix);
          if (current?.children?.length) return current.children;
          return dirTree.filter(
            (n) => n.path.startsWith(cleanPrefix + '/') && n.depth === cleanPrefix.split('/').length + 1
          );
        })();
    return candidates.filter((n) => auxSet.has(n.path));
  }, [dirTree, pendingPrefix, scopeVerdict]);

  const isCustomized = Boolean(
    (recommendedPrefix || '') !== (selectedPrefix || '') ||
    (!autoPruneAuxiliary && auxiliaryCandidates.length > 0)
  );
  const hasChanges =
    pendingPrefix !== selectedPrefix ||
    pendingAutoPrune !== autoPruneAuxiliary;

  const handleApply = () => {
    const nextExcluded = pendingAutoPrune ? auxiliaryCandidates.map((n) => n.path) : [];
    const prefixChanged = pendingPrefix !== selectedPrefix;
    const excludedChanged =
      nextExcluded.length !== excludedPaths.length ||
      nextExcluded.some((p, idx) => p !== excludedPaths[idx]);

    setOpen(false);
    if (!prefixChanged && !excludedChanged && pendingAutoPrune === autoPruneAuxiliary) {
      return;
    }

    wizardSetters.setAutoPruneAuxiliary(pendingAutoPrune);
    wizardSetters.setSelectedPrefix(pendingPrefix);
    wizardSetters.setExcludedPaths(nextExcluded);
    wizardSetters.setOutlineExcluded([]);
    wizardSetters.setCustomOutline([]);
    onDirectoryApplied?.();
  };

  const handleResetToRecommended = () => {
    setPendingPrefix(recommendedPrefix || '');
    setPendingAutoPrune(true);
  };

  return (
    <Popover open={open} onOpenChange={(nextOpen) => !disabled && setOpen(nextOpen)}>
      <PopoverTrigger
        disabled={disabled}
        className={
          isCustomized
            ? 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-theme-primary/15 border border-theme-primary/50 text-theme-primary text-xs font-medium cursor-pointer transition-all hover:bg-theme-primary/20 shadow-2xs active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed'
            : 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-theme-surface border border-theme-primary/35 text-theme-foreground hover:border-theme-primary/70 hover:bg-theme-primary/10 hover:text-theme-primary text-xs font-medium cursor-pointer transition-all shadow-2xs active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed'
        }
        title={m.workbench_custom_dir_trigger()}
      >
        <FolderTree size={13} className="shrink-0 text-theme-primary" />
        <span className="font-serif">{m.workbench_custom_dir_trigger()}</span>
        <span className="px-1.5 py-0.5 rounded-md bg-theme-bg/80 border border-theme-border/60 font-mono text-caption text-theme-muted max-w-[140px] truncate">
          {selectedPrefix || '/'}
        </span>
        <ChevronDown size={12} className="shrink-0 opacity-75" />
      </PopoverTrigger>

      <PopoverPopup
        side="bottom"
        align="end"
        sideOffset={6}
        className="w-[380px] sm:w-[420px] p-0 bg-theme-bg border border-theme-border shadow-xl rounded-xl z-[130] overflow-hidden"
      >
        <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-theme-border/50 bg-theme-surface/40">
          <span className="text-xs font-serif font-semibold text-theme-foreground">
            {m.workbench_custom_dir_title()}
          </span>
          {(pendingPrefix !== (recommendedPrefix || '') || !pendingAutoPrune) && (
            <button
              type="button"
              onClick={handleResetToRecommended}
              className="inline-flex items-center gap-1 text-caption font-serif text-theme-muted hover:text-theme-primary transition-colors cursor-pointer"
            >
              <RotateCcw size={11} />
              <span>{m.workbench_custom_dir_reset()}</span>
            </button>
          )}
        </div>

        {isLargeRepo && (
          <div className="px-3.5 py-2 border-b border-theme-border/40 bg-amber-500/10 flex items-start gap-2 text-caption text-amber-700 dark:text-amber-300 leading-relaxed">
            <Info size={13} className="shrink-0 mt-0.5" />
            <span>{m.workbench_custom_dir_large_repo_hint({ count: totalFiles.toLocaleString() })}</span>
          </div>
        )}

        {scopeVerdict?.rationale && (
          <div className="px-3.5 py-2 border-b border-theme-border/40 bg-theme-primary/5 flex items-start gap-2 text-caption text-theme-muted leading-relaxed">
            <Sparkles size={12} className="text-theme-primary shrink-0 mt-0.5" />
            <span className="line-clamp-2">
              {m.workbench_custom_dir_ai_hint({ rationale: scopeVerdict.rationale })}
            </span>
          </div>
        )}

        <div className="p-2">
          <DirectoryCascadePicker
            dirTree={dirTree}
            selectedPrefix={pendingPrefix}
            onSelectPrefix={setPendingPrefix}
            borderless
            hideHeader
            heightClass="h-[240px]"
          />
        </div>

        <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 border-t border-theme-border/50 bg-theme-surface/30">
          {auxiliaryCandidates.length > 0 ? (
            <label className="inline-flex items-center gap-1.5 text-caption font-serif text-theme-muted hover:text-theme-foreground cursor-pointer select-none">
              <Checkbox
                checked={pendingAutoPrune}
                onCheckedChange={(checked) => setPendingAutoPrune(Boolean(checked))}
              />
              <span>
                {m.scout_auto_prune()} (-{auxiliaryCandidates.length})
              </span>
            </label>
          ) : (
            <span className="text-caption font-mono text-theme-muted truncate max-w-[160px]">
              {pendingPrefix || '/'}
            </span>
          )}

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-2.5 py-1 text-xs font-serif text-theme-muted hover:text-theme-foreground rounded-lg transition-colors cursor-pointer"
            >
              {m.common_cancel()}
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={!hasChanges}
              className="px-3 py-1 text-xs font-serif font-semibold rounded-lg bg-theme-primary text-theme-primary-fg hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
            >
              {m.workbench_custom_dir_apply()}
            </button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
