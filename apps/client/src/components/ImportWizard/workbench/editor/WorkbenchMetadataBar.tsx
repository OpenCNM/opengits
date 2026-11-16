'use client';

import React, { useEffect, useRef } from 'react';
import { Tag, FolderKanban } from 'lucide-react';
import { useImportWizardStore, wizardSetters } from '@/lib/stores/import-wizard-store';
import { normalizeCategory } from '@/lib/constants';
import * as m from '@/paraglide/messages';

function getDomainOptions(): Array<{ value: string; label: string }> {
  return [
    { value: 'AI', label: m.category_ai_ml() },
    { value: 'Systems', label: m.category_systems() },
    { value: 'Cloud', label: m.category_cloud() },
    { value: 'Web', label: m.category_web() },
    { value: 'Mobile', label: m.category_mobile() },
    { value: 'Gaming', label: m.category_gaming() },
    { value: 'Hardware', label: m.category_hardware() },
    { value: 'Finance', label: m.category_finance() },
    { value: 'Science', label: m.category_science() },
    { value: 'Books', label: m.category_books() },
    { value: 'Others', label: m.category_others() },
  ];
}

export function WorkbenchMetadataBar() {
  const category = useImportWizardStore((s) => s.category);
  const selectedTags = useImportWizardStore((s) => s.selectedTags);
  const draftOutline = useImportWizardStore((s) => s.draftOutline);
  const { setCategory, setSelectedTags } = wizardSetters;

  const lastDraftRef = useRef<unknown>(null);

  // 若 draftOutline 伴生产出了 category/tags 且尚未为本份大纲初始化过，自动同步预填
  useEffect(() => {
    if (draftOutline && typeof draftOutline === 'object') {
      if (lastDraftRef.current === draftOutline) return;
      lastDraftRef.current = draftOutline;

      const draft = draftOutline as { category?: unknown; tags?: unknown };
      if (typeof draft.category === 'string' && draft.category.trim() && (!category || category === 'Others')) {
        const norm = normalizeCategory(draft.category);
        if (norm && norm !== 'Others') {
          setCategory(norm);
        }
      }
      if (Array.isArray(draft.tags) && draft.tags.length > 0 && selectedTags.length === 0) {
        const valid = draft.tags
          .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          .map((t) => t.trim());
        if (valid.length > 0) {
          setSelectedTags(valid);
        }
      }
    }
  }, [draftOutline, category, selectedTags.length, setCategory, setSelectedTags]);

  const currentDomain = normalizeCategory(category) || 'Others';
  const currentDomainLabel =
    getDomainOptions().find((opt) => opt.value === currentDomain)?.label || currentDomain;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2.5 mb-3 px-3 py-2 bg-theme-surface/60 border border-theme-border/60 rounded-lg text-xs shrink-0">
      {/* 领域展示（只读） */}
      <div className="flex items-center gap-2">
        <span className="text-theme-muted font-medium flex items-center gap-1.5 shrink-0">
          <FolderKanban className="w-3.5 h-3.5 text-theme-primary" />
          <span>{m.workbench_meta_domain()}</span>
        </span>
        <span className="px-2.5 py-0.5 text-xs font-semibold text-theme-foreground bg-theme-bg border border-theme-border/80 rounded-md">
          {currentDomainLabel}
        </span>
      </div>

      {/* 标签药丸列表（只读） */}
      {selectedTags.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap min-w-0 flex-1 justify-end">
          <span className="text-theme-muted font-medium flex items-center gap-1 shrink-0">
            <Tag className="w-3 h-3 text-theme-muted" />
            <span>{m.workbench_meta_tags()}</span>
          </span>

          {selectedTags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center px-2 py-0.5 rounded bg-theme-bg border border-theme-border/80 text-micro font-mono text-theme-foreground"
            >
              <span>#{tag}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
