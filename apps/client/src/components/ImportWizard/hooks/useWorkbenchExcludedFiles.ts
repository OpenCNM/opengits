'use client';

import { useState } from 'react';
import { useImportWizardStore, wizardSetters } from '@/lib/stores/import-wizard-store';
import * as m from '@/paraglide/messages';

export function useWorkbenchExcludedFiles() {
  const customOutline = useImportWizardStore((s) => s.customOutline);
  const outlineExcluded = useImportWizardStore((s) => s.outlineExcluded);

  const { setCustomOutline, setOutlineExcluded, setIsOutlineDirty } = wizardSetters;

  const [excludedPanelOpen, setExcludedPanelOpen] = useState(false);
  const [excludedChecked, setExcludedChecked] = useState<Set<string>>(new Set());

  const toggleExcludedChecked = (path: string) => {
    setExcludedChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleRestoreCheckedFiles = () => {
    const restored = outlineExcluded.filter((f) => excludedChecked.has(f.path));
    if (restored.length === 0) return;
    setCustomOutline([
      ...customOutline,
      {
        name: m.workbench_restore_chapter_title(),
        files: restored.map((f) => ({
          path: f.path,
          shortTitle: f.path.split('/').pop() || f.path,
        })),
      },
    ]);
    setOutlineExcluded(outlineExcluded.filter((f) => !excludedChecked.has(f.path)));
    setExcludedChecked(new Set());
    setIsOutlineDirty(true);
  };

  return {
    outlineExcluded,
    excludedPanelOpen,
    setExcludedPanelOpen,
    excludedChecked,
    toggleExcludedChecked,
    handleRestoreCheckedFiles,
  };
}
