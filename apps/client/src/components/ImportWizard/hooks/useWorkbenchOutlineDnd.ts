'use client';

import React from 'react';
import { useImportWizardStore, wizardSetters } from '@/lib/stores/import-wizard-store';

export function useWorkbenchOutlineDnd() {
  const customOutline = useImportWizardStore((s) => s.customOutline);
  const draggedCatIndex = useImportWizardStore((s) => s.draggedCatIndex);
  const dragOverCatIndex = useImportWizardStore((s) => s.dragOverCatIndex);

  const {
    setCustomOutline,
    setIsOutlineDirty,
    setDraggedCatIndex,
    setDraggedFile,
    setDragOverCatIndex,
  } = wizardSetters;

  const handleDragStartCat = (e: React.DragEvent, idx: number) => {
    setDraggedCatIndex(idx);
    e.dataTransfer.effectAllowed = 'move';
    e.currentTarget.classList.add('opacity-40');
  };

  const handleDragEndCat = (e: React.DragEvent) => {
    setDraggedCatIndex(null);
    setDragOverCatIndex(null);
    e.currentTarget.classList.remove('opacity-40');
  };

  const handleDragOverCat = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (draggedCatIndex !== null && draggedCatIndex !== idx) {
      setDragOverCatIndex(idx);
    }
  };

  const handleDropCat = (e: React.DragEvent, dropIdx: number) => {
    e.preventDefault();
    setDragOverCatIndex(null);
    if (draggedCatIndex !== null && draggedCatIndex !== dropIdx) {
      const newOutline = [...customOutline];
      const [moved] = newOutline.splice(draggedCatIndex, 1);
      newOutline.splice(dropIdx, 0, moved);
      setCustomOutline(newOutline);
      setIsOutlineDirty(true);
    }
    setDraggedCatIndex(null);
  };

  const handleDragStartFile = (e: React.DragEvent, catIndex: number, fileIndex: number) => {
    e.stopPropagation();
    setDraggedFile({ catIndex, fileIndex });
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOverFile = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDropFile = (e: React.DragEvent, targetCatIdx: number, targetFileIdx?: number) => {
    e.preventDefault();
    e.stopPropagation();
    const dragged = useImportWizardStore.getState().draggedFile;
    if (!dragged) return;

    const { catIndex: fromCat, fileIndex: fromFile } = dragged;
    const newOutline = [...customOutline];
    const [moved] = newOutline[fromCat].files.splice(fromFile, 1);

    if (targetFileIdx !== undefined) {
      newOutline[targetCatIdx].files.splice(targetFileIdx, 0, moved);
    } else {
      newOutline[targetCatIdx].files.push(moved);
    }

    setCustomOutline(newOutline);
    setIsOutlineDirty(true);
    setDraggedFile(null);
  };

  return {
    dragOverCatIndex,
    handleDragStartCat,
    handleDragEndCat,
    handleDragOverCat,
    handleDropCat,
    handleDragStartFile,
    handleDragOverFile,
    handleDropFile,
  };
}
