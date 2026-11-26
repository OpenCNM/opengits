'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useImportWizardStore, wizardSetters } from '@/lib/stores/import-wizard-store';
import {
  saveWorkbenchDraft,
  loadWorkbenchDraft,
  clearWorkbenchDraft,
  formatDraftTimeAgo,
} from '@/lib/import-wizard/draft-storage';
import { toastManager } from '@/components/ui/toast';
import * as m from '@/paraglide/messages';

export function useWorkbenchDraft() {
  const scoutData = useImportWizardStore((s) => s.scoutData);
  const customOutline = useImportWizardStore((s) => s.customOutline);
  const originalOutlineSnapshot = useImportWizardStore((s) => s.originalOutlineSnapshot);
  const hasRecoverableDraft = useImportWizardStore((s) => s.hasRecoverableDraft);
  const recoverableDraftUpdatedAt = useImportWizardStore((s) => s.recoverableDraftUpdatedAt);
  const customPrompt = useImportWizardStore((s) => s.customPrompt);
  const transcriptionPreset = useImportWizardStore((s) => s.transcriptionPreset);
  const targetLanguage = useImportWizardStore((s) => s.targetLanguage);
  const isOutlineDirty = useImportWizardStore((s) => s.isOutlineDirty);
  const step = useImportWizardStore((s) => s.step);

  const {
    setCustomOutline,
    setOriginalOutlineSnapshot,
    setHasRecoverableDraft,
    setRecoverableDraftUpdatedAt,
    setCustomPrompt,
    setTranscriptionPreset,
    setTargetLanguage,
    setIsOutlineDirty,
  } = wizardSetters;

  const [lastSavedTime, setLastSavedTime] = useState<number | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hasCheckedDraftRef = useRef(false);

  const owner = scoutData?.owner;
  const repo = scoutData?.repo;
  const currentSha = (scoutData?.currentSha as string) || null;

  useEffect(() => {
    if (step !== 2 || !owner || !repo) return;
    if (hasCheckedDraftRef.current) return;
    hasCheckedDraftRef.current = true;

    const draft = loadWorkbenchDraft(owner, repo, currentSha);
    if (draft && draft.customOutline && draft.customOutline.length > 0) {
      setHasRecoverableDraft(true);
      setRecoverableDraftUpdatedAt(draft.updatedAt);
    }
  }, [step, owner, repo, currentSha, setHasRecoverableDraft, setRecoverableDraftUpdatedAt]);

  useEffect(() => {
    if (customOutline.length > 0 && !originalOutlineSnapshot && !isOutlineDirty) {
      setOriginalOutlineSnapshot(structuredClone(customOutline));
    }
  }, [customOutline, originalOutlineSnapshot, isOutlineDirty, setOriginalOutlineSnapshot]);

  useEffect(() => {
    if (step !== 2 || !owner || !repo || customOutline.length === 0) return;
    if (!isOutlineDirty) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      const ok = saveWorkbenchDraft(owner, repo, {
        sha: currentSha || undefined,
        customOutline,
        customPrompt,
        transcriptionPreset,
        targetLanguage,
      });
      if (ok) {
        setLastSavedTime(Date.now());
      }
    }, 600);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [step, owner, repo, currentSha, customOutline, customPrompt, transcriptionPreset, targetLanguage, isOutlineDirty]);

  const handleRecoverDraft = useCallback(() => {
    if (!owner || !repo) return;
    const draft = loadWorkbenchDraft(owner, repo, currentSha);
    if (!draft) {
      setHasRecoverableDraft(false);
      return;
    }

    setCustomOutline(structuredClone(draft.customOutline));
    if (draft.customPrompt !== undefined) setCustomPrompt(draft.customPrompt);
    if (draft.transcriptionPreset !== undefined) setTranscriptionPreset(draft.transcriptionPreset);
    if (draft.targetLanguage !== undefined) setTargetLanguage(draft.targetLanguage);
    setIsOutlineDirty(true);
    setHasRecoverableDraft(false);

    toastManager.add({
      type: 'info',
      title: m.import_draft_restored_title(),
      description: m.import_draft_restored_desc({ time: formatDraftTimeAgo(draft.updatedAt) }),
    });
  }, [owner, repo, currentSha, setCustomOutline, setCustomPrompt, setTranscriptionPreset, setTargetLanguage, setIsOutlineDirty, setHasRecoverableDraft]);

  const handleDiscardDraft = useCallback(() => {
    if (!owner || !repo) return;
    clearWorkbenchDraft(owner, repo);
    setHasRecoverableDraft(false);
    setRecoverableDraftUpdatedAt(null);
  }, [owner, repo, setHasRecoverableDraft, setRecoverableDraftUpdatedAt]);

  const handleResetToOriginal = useCallback(() => {
    if (!originalOutlineSnapshot || originalOutlineSnapshot.length === 0) return;
    setCustomOutline(structuredClone(originalOutlineSnapshot));
    setIsOutlineDirty(false);
    if (owner && repo) {
      clearWorkbenchDraft(owner, repo);
    }
    toastManager.add({
      type: 'info',
      title: m.import_draft_reset_title(),
      description: m.import_draft_reset_desc(),
    });
  }, [originalOutlineSnapshot, setCustomOutline, setIsOutlineDirty, owner, repo]);

  return {
    hasRecoverableDraft,
    recoverableDraftTimeText: recoverableDraftUpdatedAt ? formatDraftTimeAgo(recoverableDraftUpdatedAt) : '',
    lastSavedTime,
    canResetToOriginal: Boolean(isOutlineDirty && originalOutlineSnapshot && originalOutlineSnapshot.length > 0),
    handleRecoverDraft,
    handleDiscardDraft,
    handleResetToOriginal,
  };
}
