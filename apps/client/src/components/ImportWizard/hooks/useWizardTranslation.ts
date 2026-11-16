'use client';

import { executeTranslateOutline, reextractSingleFileTitle } from '@/lib/import-wizard/outline-translator';
import { wizardSetters, useImportWizardStore } from '@/lib/stores/import-wizard-store';

// 翻译流控制器（模块级：向导单实例）。新翻译启动前 abort 旧流；向导
// 关闭/重置（resetWizard）调用 cancelWizardTranslation() 断流——浏览器
// 断开 fetch 即触发服务端 AbortSignal 级联，BYOK LLM 生成随即停止。
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
