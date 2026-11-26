'use client';

import React, { createContext, useContext, useEffect, ReactNode } from 'react';
import { resolveTranscriptionPreset } from '@/lib/transcription-presets';
import { ParsedGithubUrl } from '@/lib/url-parser';
import {
  useImportWizardStore,
  wizardSetters,
  wizardFlow,
  readPersistedTargetLanguage,
  type WizardDedupInfo,
  type ScoutErrorInfo,
  type WizardScoutData,
} from '@/lib/stores/import-wizard-store';
import { readPendingImportReauth, clearPendingImportReauth } from '@/lib/stores/pending-import-reauth';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { useSafeSession } from '@/lib/useSafeSession';
import { api, ApiClientError } from '@/lib/api/client';

import { useWizardScout } from './hooks/useWizardScout';
import { useWizardTranslation } from './hooks/useWizardTranslation';
import { useWizardIngestSubmission } from './hooks/useWizardIngestSubmission';

import type { WebDocScoutPhase } from '@/lib/import-wizard/webdoc-scope';

interface ImportWizardContextType {
  step: number;
  setStep: (step: number | ((prev: number) => number)) => void;
  subStep: 'input' | 'directory_confirm' | 'outline_draft' | 'web_confirm';
  setSubStep: (subStep: 'input' | 'directory_confirm' | 'outline_draft' | 'web_confirm') => void;
  onConfirmDirectory: () => void;
  importMode: 'github' | 'web';
  webScoutPhase: WebDocScoutPhase;
  setWebScoutPhase: (phase: WebDocScoutPhase) => void;
  submitWebDocImport: (params: {
    maxPages: number;
    isPublic: boolean;
    scope?: import('@/lib/schemas/webdoc-topology').WebDocScopeParams;
  }) => Promise<void>;
  retryWebDocImport: () => Promise<void>;
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  url: string;
  setUrl: (url: string) => void;
  loading: boolean;
  setLoading: (l: boolean) => void;
  isReauthorizing: boolean;
  setIsReauthorizing: (r: boolean) => void;
  prefixLoading: boolean;
  setPrefixLoading: (l: boolean) => void;
  isTranslatingOutline: boolean;
  hasAutoTranslated: boolean;
  translatingIndices: Set<string>;
  scoutData: WizardScoutData | null;
  userPrefs: Record<string, unknown> | null;

  importScopeMode: 'full_repo' | 'single_doc';
  setImportScopeMode: (mode: 'full_repo' | 'single_doc') => void;
  targetLandingPath: string;
  setTargetLandingPath: (path: string) => void;
  parsedUrlInfo: ParsedGithubUrl | null;
  dedupInfo: WizardDedupInfo | null;
  setDedupInfo: (info: WizardDedupInfo | null) => void;
  scoutSameSource: { owner: string; repo: string; similarity: number; method: string } | null;
  hasDismissedDedup: boolean;
  setHasDismissedDedup: (dismissed: boolean) => void;
  scoutError: ScoutErrorInfo | null;
  setScoutError: (err: ScoutErrorInfo | null) => void;

  recommendedPrefix: string;
  selectedPrefix: string;
  setSelectedPrefix: (prefix: string) => void;
  menuStyle: string;
  setMenuStyle: (style: string) => void;
  targetLanguage: string;
  setTargetLanguage: (lang: string) => void;
  customPrompt: string;
  setCustomPrompt: (prompt: string) => void;
  aiCondensation: string;
  setAiCondensation: (c: string) => void;
  teachingDepth: 'overview' | 'standard' | 'deep';
  setTeachingDepth: (depth: 'overview' | 'standard' | 'deep') => void;
  transcriptionPreset: string;
  applyTranscriptionPreset: (presetId: string) => void;
  createEdition: boolean;
  setCreateEdition: (create: boolean) => void;
  editionLabel: string;
  setEditionLabel: (label: string) => void;
  ackCost: boolean;
  setAckCost: (ack: boolean) => void;
  versionLabel: string;
  setVersionLabel: (v: string) => void;
  customExtensions: string[];
  setCustomExtensions: (exts: string[]) => void;

  isPublic: boolean;
  setIsPublic: (isPub: boolean) => void;
  category: string;
  setCategory: (cat: string) => void;
  selectedTags: string[];
  setSelectedTags: (tags: string[]) => void;
  customTagInput: string;
  setCustomTagInput: (input: string) => void;
  tagPool: string[];
  setTagPool: (pool: string[] | ((prev: string[]) => string[])) => void;

  customOutline: any[];
  setCustomOutline: (outline: any[] | ((prev: any[]) => any[])) => void;
  outlineExcluded: Array<{ path: string; reason: string; note?: string }>;
  setOutlineExcluded: (files: Array<{ path: string; reason: string; note?: string }>) => void;
  collapsedCategories: Record<number, boolean>;
  setCollapsedCategories: (cats: Record<number, boolean> | ((prev: Record<number, boolean>) => Record<number, boolean>)) => void;
  isOutlineDirty: boolean;
  setIsOutlineDirty: (dirty: boolean) => void;

  draggedCatIndex: number | null;
  setDraggedCatIndex: (idx: number | null) => void;
  draggedFile: { catIndex: number; fileIndex: number } | null;
  setDraggedFile: (file: { catIndex: number; fileIndex: number } | null) => void;
  dragOverCatIndex: number | null;
  setDragOverCatIndex: (idx: number | null) => void;

  logs: string[];
  setLogs: (logs: string[] | ((prev: string[]) => string[])) => void;
  scoutSteps: Array<{ stage: string; tag: string; title: string; detail: string }>;
  setScoutSteps: (steps: Array<{ stage: string; tag: string; title: string; detail: string }> | ((prev: Array<{ stage: string; tag: string; title: string; detail: string }>) => Array<{ stage: string; tag: string; title: string; detail: string }>)) => void;
  ingestSuccessInfo: { owner: string; repo: string; landingPath?: string } | null;
  setIngestSuccessInfo: (info: { owner: string; repo: string; landingPath?: string } | null) => void;

  showConfirmCloseDialog: boolean;
  setShowConfirmCloseDialog: (open: boolean) => void;
  showIngestAbortDialog: boolean;
  setShowIngestAbortDialog: (open: boolean) => void;
  showEmptyCategoryDialog: boolean;
  setShowEmptyCategoryDialog: (open: boolean) => void;
  emptyCategoriesCount: number;
  setEmptyCategoriesCount: (count: number) => void;
  ingestFailed: boolean;

  handleCloseRequest: () => void;
  resetWizard: () => void;
  openWizard: () => void;
  openWizardForEdition: (owner: string, repo: string) => void;
  handleScout: (overrideUrl?: string, options?: { forceScout?: boolean }) => Promise<void>;
  proceedToStep2: (customPrefix?: string) => Promise<void>;
  needsTranslation: () => boolean;
  translateOutline: (manual?: boolean) => Promise<boolean>;
  handleIngest: () => Promise<void>;
  validateOutline: () => boolean;
  reextractFileTitle: (catIdx: number, fileIdx: number) => Promise<void>;
}

const ImportWizardContext = createContext<ImportWizardContextType | undefined>(undefined);

export function ImportWizardProvider({ children }: { children: ReactNode }) {
  const wizard = useImportWizardStore();
  const {
    isOpen, step, subStep, importMode, webScoutPhase, url, loading, isReauthorizing, prefixLoading, isTranslatingOutline,
    hasAutoTranslated, translatingIndices, scoutData, userPrefs,
    recommendedPrefix, selectedPrefix, menuStyle, targetLanguage, customPrompt,
    aiCondensation, teachingDepth, transcriptionPreset, createEdition, editionLabel, ackCost,
    versionLabel, customExtensions, isPublic, category, selectedTags, customTagInput,
    tagPool, customOutline, collapsedCategories, isOutlineDirty, outlineExcluded, showEmptyCategoryDialog, emptyCategoriesCount,
    showConfirmCloseDialog, showIngestAbortDialog, ingestFailed,
    importScopeMode, targetLandingPath, parsedUrlInfo, dedupInfo, scoutSameSource,
    hasDismissedDedup, draggedCatIndex, draggedFile, dragOverCatIndex,
    scoutError, logs, scoutSteps, ingestSuccessInfo,
  } = wizard;

  const {
    setIsOpen, setStep, setSubStep, setWebScoutPhase, setUrl, setLoading, setIsReauthorizing, setPrefixLoading,
    setUserPrefs, setMenuStyle, setTargetLanguage,
    setCustomPrompt, setAiCondensation, setTeachingDepth, setTranscriptionPreset,
    setCreateEdition, setEditionLabel, setAckCost, setVersionLabel, setCustomExtensions, setIsPublic,
    setCategory, setSelectedTags, setCustomTagInput, setTagPool, setCustomOutline,
    setCollapsedCategories, setIsOutlineDirty,
    setShowEmptyCategoryDialog, setEmptyCategoriesCount,
    setShowConfirmCloseDialog, setShowIngestAbortDialog,
    setImportScopeMode, setTargetLandingPath, setDedupInfo,
    setHasDismissedDedup, setDraggedCatIndex, setDraggedFile, setDragOverCatIndex,
    setLogs, setScoutSteps, setIngestSuccessInfo, setScoutError, setImportMode,
  } = wizardSetters;

  const { locale } = useLocale();

  useEffect(() => {
    const persisted = readPersistedTargetLanguage();
    if (persisted) {
      setTargetLanguage(persisted);
      return;
    }
    const current = useImportWizardStore.getState().targetLanguage;
    if (!current && locale) {
      setTargetLanguage(locale);
    }
  }, [locale, setTargetLanguage]);

  const applyTranscriptionPreset = (presetId: string) => {
    setTranscriptionPreset(presetId);
    setMenuStyle(presetId === 'faithful' ? 'native' : 'ai');
    const preset = resolveTranscriptionPreset(presetId);
    if (preset.defaults?.aiCondensation) setAiCondensation(preset.defaults.aiCondensation);
  };

  const { handleScout, proceedToStep2, handleSelectPrefix } = useWizardScout(locale);

  const {
    openWizard,
    openWizardForEdition,
    handleCloseRequest,
    resetWizard,
    executeIngestion,
    handleIngest,
    submitWebDocImport,
    retryWebDocImport,
    validateOutline,
  } = useWizardIngestSubmission(locale);

  const { needsTranslation, translateOutline, reextractFileTitle } = useWizardTranslation();

  const hasCheckedPendingReauthRef = React.useRef(false);
  useEffect(() => {
    if (hasCheckedPendingReauthRef.current) return;
    hasCheckedPendingReauthRef.current = true;

    const pending = readPendingImportReauth();
    if (pending && pending.url) {
      clearPendingImportReauth();
      setUrl(pending.url);
      if (pending.createEdition) {
        setCreateEdition(true);
      }
      if (pending.targetLanguage) {
        setTargetLanguage(pending.targetLanguage);
      }
      if (typeof pending.isPublic === 'boolean') {
        setIsPublic(pending.isPublic);
      }
      if (pending.importMode) {
        setImportMode(pending.importMode);
      }
      wizardFlow.openAtInput();
      handleScout(pending.url);
    }
  }, [handleScout, setCreateEdition, setImportMode, setIsPublic, setTargetLanguage, setUrl]);

  const { data: session, status: sessionStatus } = useSafeSession();

  useEffect(() => {
    async function loadPreferences() {
      try {
        const data = await api.get<{
          hasPreferencesSet?: boolean;
          preferredLang1?: string;
          industry?: string;
        }>('/api/user/preferences', { onUnauthorized: 'throw' });
        if (data && data.hasPreferencesSet) {
          setUserPrefs(data);
          const store = useImportWizardStore.getState();
          if (data.preferredLang1 && !store.url) {
            setTargetLanguage(data.preferredLang1);
          }
          if (data.industry) {
            const industryMap: Record<string, string> = {
              'Software': 'AI',
              'Finance': 'Economy',
              'Education': 'Computer Science',
              'Design': 'Design'
            };
            setCategory(industryMap[data.industry] || 'Others');
          }
        }
      } catch (e) {
        if (!(e instanceof ApiClientError && (e.status === 401 || e.status === 403))) {
          console.error('Failed to load user preferences', e);
        }
      }
    }
    if (sessionStatus === 'authenticated' && session?.user) {
      loadPreferences();
    }
  }, [session, sessionStatus, setCategory, setTargetLanguage, setUserPrefs]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        handleCloseRequest();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, step, isOutlineDirty, handleCloseRequest]);

  useEffect(() => {
    if (!scoutData) return;
    if (scoutData.outlinesByPrefix && scoutData.outlinesByPrefix[selectedPrefix] !== undefined) {
      setCustomOutline(structuredClone(scoutData.outlinesByPrefix[selectedPrefix] || []));
    }

    if (scoutData?.profile) {
      const mode = scoutData.profile.ingestMode || 'text_only';
      if (mode === 'code_only') {
        setMenuStyle('code_pedagogy');
        setAiCondensation('deep_code');
        setTeachingDepth('standard');
      } else if (mode === 'hybrid') {
        setMenuStyle('hybrid_merged');
        setAiCondensation('balanced');
      }
    }
  }, [selectedPrefix, scoutData, setAiCondensation, setCustomOutline, setMenuStyle, setTeachingDepth]);

  const onConfirmDirectory = () => {
    wizardSetters.enterOrchestration();
  };

return (
    <ImportWizardContext.Provider value={{
      step, setStep, isOpen, setIsOpen, url, setUrl, loading, setLoading, isReauthorizing, setIsReauthorizing, prefixLoading, setPrefixLoading, isTranslatingOutline,
      onConfirmDirectory,
      hasAutoTranslated, translatingIndices, scoutData, userPrefs,
      importScopeMode, setImportScopeMode, targetLandingPath, setTargetLandingPath, parsedUrlInfo,
      dedupInfo, setDedupInfo, hasDismissedDedup, setHasDismissedDedup, scoutSameSource, scoutError, setScoutError,
      recommendedPrefix,
      selectedPrefix, setSelectedPrefix: handleSelectPrefix, menuStyle, setMenuStyle,
      targetLanguage, setTargetLanguage, customPrompt, setCustomPrompt,
      transcriptionPreset, applyTranscriptionPreset,
      createEdition, setCreateEdition, editionLabel, setEditionLabel,
      aiCondensation, setAiCondensation, teachingDepth, setTeachingDepth, ackCost, setAckCost,
      versionLabel, setVersionLabel, customExtensions, setCustomExtensions,
      isPublic, setIsPublic, category, setCategory,
      selectedTags, setSelectedTags, customTagInput, setCustomTagInput, tagPool, setTagPool,
      customOutline, setCustomOutline, outlineExcluded, setOutlineExcluded: wizardSetters.setOutlineExcluded, collapsedCategories, setCollapsedCategories,
      isOutlineDirty, setIsOutlineDirty,
      draggedCatIndex, setDraggedCatIndex, draggedFile, setDraggedFile,
      dragOverCatIndex, setDragOverCatIndex,
      logs, setLogs, scoutSteps, setScoutSteps,
      ingestSuccessInfo, setIngestSuccessInfo,
      importMode, webScoutPhase, setWebScoutPhase, submitWebDocImport, retryWebDocImport,
      showConfirmCloseDialog, setShowConfirmCloseDialog,
      showIngestAbortDialog, setShowIngestAbortDialog,
      showEmptyCategoryDialog, setShowEmptyCategoryDialog,
      emptyCategoriesCount, setEmptyCategoriesCount,
      ingestFailed,
      handleCloseRequest, resetWizard, openWizard, openWizardForEdition, handleScout, proceedToStep2, needsTranslation, translateOutline, handleIngest, validateOutline, reextractFileTitle, subStep, setSubStep
    }}>
      {children}
    </ImportWizardContext.Provider>
  );
}

export function useImportWizard() {
  const context = useContext(ImportWizardContext);
  if (context === undefined) {
    throw new Error('useImportWizard must be used within a ImportWizardProvider');
  }
  return context;
}
