'use client';

import { executeTranslateOutline, reextractSingleFileTitle } from '@/lib/import-wizard/outline-translator';
import { wizardSetters, useImportWizardStore } from '@/lib/stores/import-wizard-store';

let translateAbort: AbortController | null = null;

export function cancelWizardTranslation() {
  translateAbort?.abort();
  translateAbort = null;
}

function freshTranslateSignal(): AbortSignal {
  translateAbort?.abort();
  translateAbort = new AbortController();
  return translateAbort.signal;
}

export function useWizardTranslation() {
  const wizard = useImportWizardStore();
  const {
    customOutline,
    targetLanguage,
    selectedPrefix,
    hasAutoTranslated,
  } = wizard;

  const {
    setIsTranslatingOutline,
    setTranslatingIndices,
    setCustomOutline,
    setIsOutlineDirty,
    setHasAutoTranslated,
  } = wizardSetters;

  const needsTranslation = () => {
    return !hasAutoTranslated;
  };

  const translateOutline = async (manual: boolean = false) => {
    setIsTranslatingOutline(true);
    const signal = freshTranslateSignal();
    try {
      const ok = await executeTranslateOutline({
        outline: customOutline,
        targetLanguage,
        selectedPrefix,
        onSetTranslatingIndices: setTranslatingIndices,
        onSetOutline: setCustomOutline,
        onSetDirty: setIsOutlineDirty,
        manual,
        signal,
      });
      if (ok) {
        setHasAutoTranslated(true);
      }
      return ok;
    } finally {
      setIsTranslatingOutline(false);
      if (translateAbort?.signal === signal) translateAbort = null;
    }
  };

  const reextractFileTitle = async (catIdx: number, fileIdx: number) => {
    const signal = freshTranslateSignal();
    try {
      await reextractSingleFileTitle({
        catIdx,
        fileIdx,
        outline: customOutline,
        targetLanguage,
        onSetTranslatingIndices: setTranslatingIndices,
        onSetOutline: setCustomOutline,
        onSetDirty: setIsOutlineDirty,
        signal,
      });
    } finally {
      if (translateAbort?.signal === signal) translateAbort = null;
    }
  };

  return {
    needsTranslation,
    translateOutline,
    reextractFileTitle,
  };
}
