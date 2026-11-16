'use client';

import { useState } from 'react';
import { useImportWizardStore, wizardSetters } from '@/lib/stores/import-wizard-store';

export function useWorkbenchCategoryOperations() {
  const customOutline = useImportWizardStore((s) => s.customOutline);
  const collapsedCategories = useImportWizardStore((s) => s.collapsedCategories);

  const {
    setCustomOutline,
    setCollapsedCategories,
    setIsOutlineDirty,
  } = wizardSetters;

  const [editingCatIndex, setEditingCatIndex] = useState<number | null>(null);
  const [editingFileKey, setEditingFileKey] = useState<string | null>(null);
  const [categoryToDelete, setCategoryToDelete] = useState<number | null>(null);

  const toggleCategory = (idx: number) => {
    setCollapsedCategories((prev) => {
      const isCurrentlyCollapsed = prev[idx] !== false;
      return { ...prev, [idx]: !isCurrentlyCollapsed };
    });
  };

  const updateCategoryName = (idx: number, newName: string) => {
    const newOutline = [...customOutline];
    const target = { ...newOutline[idx], name: newName };
    if ('title' in newOutline[idx] || (newOutline[idx] as any).title !== undefined) {
      (target as any).title = newName;
    }
    newOutline[idx] = target;
    setCustomOutline(newOutline);
    setIsOutlineDirty(true);
  };

  const confirmDeleteCategory = () => {
    if (categoryToDelete === null) return;
    const newOutline = [...customOutline];
    newOutline.splice(categoryToDelete, 1);
    setCustomOutline(newOutline);
    setIsOutlineDirty(true);
    setCategoryToDelete(null);
  };

  const updateFileShortTitle = (catIdx: number, fileIdx: number, newTitle: string) => {
    const newOutline = [...customOutline];
    newOutline[catIdx].files[fileIdx].shortTitle = newTitle;
    setCustomOutline(newOutline);
    setIsOutlineDirty(true);
  };

  const deleteFile = (catIdx: number, fileIdx: number) => {
    const newOutline = [...customOutline];
    newOutline[catIdx].files.splice(fileIdx, 1);
    setCustomOutline(newOutline);
    setIsOutlineDirty(true);
  };

  return {
    customOutline,
    collapsedCategories,
    editingCatIndex,
    setEditingCatIndex,
    editingFileKey,
    setEditingFileKey,
    categoryToDelete,
    setCategoryToDelete,
    toggleCategory,
    updateCategoryName,
    confirmDeleteCategory,
    updateFileShortTitle,
    deleteFile,
  };
}
