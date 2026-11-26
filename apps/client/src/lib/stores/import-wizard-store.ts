import { create } from 'zustand';
import { STORAGE_KEYS, SUPPORTED_LANGUAGES, TRANSLATION_LANGUAGES } from '@/lib/constants';
import { DEFAULT_TRANSCRIPTION_PRESET_ID } from '@/lib/transcription-presets';
import type { UpstreamErrorMeta } from '@/lib/llm-gateway/upstream-error';
import type { DedupResult } from '@/lib/repo-dedup';
import type { ScoutPipelineResult } from '@/lib/scout/pipeline/types';
import type {
  WizardLifecycleState,
  WizardLifecycleInput,
  WizardCloseAction,
  WizardCapsuleStatusKind,
  WizardCapsuleState,
  WizardCapsuleInput,
} from '@/lib/state/curriculum-lifecycle-contract';
import {
  projectWizardLifecycleState,
  projectWizardCloseAction,
  projectWizardCapsuleState,
} from '@/lib/state/curriculum-state-projector';
import { createMemoizedObjectSelector } from './memoize-selector';

export type {
  WizardLifecycleState,
  WizardLifecycleInput,
  WizardCloseAction,
  WizardCapsuleStatusKind,
  WizardCapsuleState,
  WizardCapsuleInput,
};
export {
  projectWizardLifecycleState,
  projectWizardCloseAction,
  projectWizardCapsuleState,
};

export interface ScoutErrorInfo {
  status?: string;
  error?: string;
  diagnosticDescription?: string;
  suggestedFormat?: string;
  httpStatus?: number;
}

export interface WizardScoutData {
  owner?: string;
  repo?: string;
  branch?: string;
  currentSha?: string | null;
  fileCount?: number;
  starCount?: number;
  pushedAt?: string | null;
  profile?: any;
  versions?: any[];
  dirTree?: any[];
  aiCategory?: string;
  aiTags?: unknown;
  paradigm?: string;
  parallelTracks?: string[];
  exclusionReport?: any;
  dedupInfo?: any;
  sameSource?: any;
  outlinesByPrefix?: Record<string, any[]>;
  prefixTimings?: Record<string, any>;
  primaryLanguage?: string;
  [key: string]: unknown;
}

import type { WebDocScoutPhase } from '@/lib/import-wizard/webdoc-scope';
import type { ModuleTab } from '@/lib/schemas/webdoc-topology';

export type WizardSubStep = 'input' | 'directory_confirm' | 'outline_draft' | 'web_confirm';

export interface WebDocScoutSnapshot {
  url: string;
  status: 'loading' | 'ready' | 'scan_failed';
  reason?: string;
  scoutStatus?: 'multi_module' | 'single_module';
  primaryDocPrefix?: string;
  moduleTabs?: ModuleTab[];
  sidebarHeadings?: string[];
}

export interface WizardDedupInfo extends DedupResult {
  currentSha?: string | null;
  importedSha?: string | null;
  hasUpdate?: boolean;
}

export interface ImportWizardData {
  isOpen: boolean;
  isCollapsed: boolean;
  step: number;
  subStep: WizardSubStep;
  importMode: 'github' | 'web';
  webScoutPhase: WebDocScoutPhase;
  webScoutState: WebDocScoutSnapshot | null;
  webScopeMode: 'recommended' | 'all';
  webSelectedPaths: string[];
  url: string;
  scoutedUrl: string;
  loading: boolean;
  isReauthorizing: boolean;
  prefixLoading: boolean;
  isTranslatingOutline: boolean;
  hasAutoTranslated: boolean;
  translatingIndices: Set<string>;
  scoutData: WizardScoutData | null;
  excludedPaths: string[];
  autoPruneAuxiliary: boolean;
  userPrefs: Record<string, unknown> | null;

  recommendedPrefix: string;
  selectedPrefix: string;
  menuStyle: string;
  targetLanguage: string;
  customPrompt: string;
  aiCondensation: string;
  teachingDepth: 'overview' | 'standard' | 'deep';
  transcriptionPreset: string;
  createEdition: boolean;
  editionLabel: string;
  ackCost: boolean;
  versionLabel: string;
  customExtensions: string[];

  isPublic: boolean;
  category: string;
  selectedTags: string[];
  customTagInput: string;
  tagPool: string[];

  customOutline: any[];
  originalOutlineSnapshot: any[] | null;
  hasRecoverableDraft: boolean;
  recoverableDraftUpdatedAt: number | null;
  collapsedCategories: Record<number, boolean>;
  isOutlineDirty: boolean;
  outlineExcluded: Array<{ path: string; reason: string; note?: string }>;

  draftOutline: any;
  draftLoading: boolean;
  outlineGenError: string | null;
  draftTimings: any;
  draftScaleDecision: any;
  isGiantScope: boolean;
  draftUserPrompt: string;

  showEmptyCategoryDialog: boolean;
  emptyCategoriesCount: number;
  showConfirmCloseDialog: boolean;
  showIngestAbortDialog: boolean;
  ingestFailed: boolean;
  ingestError: UpstreamErrorMeta | null;
  repoPreExisted: boolean;

  importScopeMode: 'full_repo' | 'single_doc';
  targetLandingPath: string;
  parsedUrlInfo: any;
  dedupInfo: WizardDedupInfo | null;
  scoutSameSource: { owner: string; repo: string; similarity: number; method: string } | null;
  hasDismissedDedup: boolean;

  draggedCatIndex: number | null;
  draggedFile: { catIndex: number; fileIndex: number } | null;
  dragOverCatIndex: number | null;

  logs: string[];
  scoutSteps: Array<{ stage: string; tag: string; title: string; detail: string }>;
  draftSteps: Array<{ stage: string; tag: string; title: string; detail: string; timestamp?: string }>;
  ingestSuccessInfo: { owner: string; repo: string; landingPath?: string; edition?: string } | null;

  isSubmitting: boolean;
  submittedJobId: string | null;

  scoutError: {
    status?: string;
    error?: string;
    diagnosticDescription?: string;
    suggestedFormat?: string;
    httpStatus?: number;
  } | null;
}

export function createInitialWizardData(locale?: string | null): ImportWizardData {
  return {
    isOpen: false,
    isCollapsed: false,
    isSubmitting: false,
    submittedJobId: null,
    step: 1,
    subStep: 'input',
    importMode: 'github',
    webScoutPhase: 'idle',
    webScoutState: null,
    webScopeMode: 'recommended',
    webSelectedPaths: [],
    url: '',
    scoutedUrl: '',
    loading: false,
    isReauthorizing: false,
    prefixLoading: false,
    isTranslatingOutline: false,
    hasAutoTranslated: false,
    translatingIndices: new Set(),
    scoutData: null,
    excludedPaths: [],
    autoPruneAuxiliary: true,
    userPrefs: null,

    recommendedPrefix: '',
    selectedPrefix: '',
    menuStyle: 'ai',
    targetLanguage: locale || 'en',
    customPrompt: '',
    aiCondensation: 'balanced',
    teachingDepth: 'standard',
    transcriptionPreset: DEFAULT_TRANSCRIPTION_PRESET_ID,
    createEdition: false,
    editionLabel: '',
    ackCost: false,
    versionLabel: '',
    customExtensions: [],

    isPublic: true,
    category: 'Others',
    selectedTags: [],
    customTagInput: '',
    tagPool: ['React', 'Next.js', 'TypeScript', 'Node.js', 'Python', 'AI', 'LLM', 'Docker'],

    customOutline: [],
    originalOutlineSnapshot: null,
    hasRecoverableDraft: false,
    recoverableDraftUpdatedAt: null,
    collapsedCategories: {},
    isOutlineDirty: false,
    outlineExcluded: [],

    draftOutline: null,
    draftLoading: false,
    outlineGenError: null,
    draftTimings: null,
    draftScaleDecision: null,
    isGiantScope: false,
    draftUserPrompt: '',

    showEmptyCategoryDialog: false,
    emptyCategoriesCount: 0,
    showConfirmCloseDialog: false,
    showIngestAbortDialog: false,
    ingestFailed: false,
    ingestError: null,
    repoPreExisted: false,

    importScopeMode: 'full_repo',
    targetLandingPath: '',
    parsedUrlInfo: null,
    dedupInfo: null,
    scoutSameSource: null,
    hasDismissedDedup: false,

    draggedCatIndex: null,
    draggedFile: null,
    dragOverCatIndex: null,

    logs: [],
    scoutSteps: [],
    draftSteps: [],
    ingestSuccessInfo: null,

    scoutError: null,
  };
}

export const useImportWizardStore = create<ImportWizardData>(() => createInitialWizardData());

const VALID_TARGET_LANGUAGES = new Set([
  TRANSLATION_LANGUAGES.NONE_CODE,
  ...SUPPORTED_LANGUAGES.map((l) => l.code),
]);

export function readPersistedTargetLanguage(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEYS.WIZARD_TARGET_LANGUAGE);
    if (saved && VALID_TARGET_LANGUAGES.has(saved)) {
      return saved;
    }
  } catch (err) {
    console.warn('[import-wizard-store] Failed to read persisted targetLanguage:', err);
  }
  return null;
}

function persistTargetLanguage(lang: string): void {
  if (typeof window === 'undefined' || !VALID_TARGET_LANGUAGES.has(lang)) return;
  try {
    window.localStorage.setItem(STORAGE_KEYS.WIZARD_TARGET_LANGUAGE, lang);
  } catch (err) {
    console.warn('[import-wizard-store] Failed to persist targetLanguage:', err);
  }
}

export function createWizardResetPatch(locale?: string | null): Partial<ImportWizardData> {
  const initial = createInitialWizardData(locale);
  const persistedLang = readPersistedTargetLanguage();
  return {
    isOpen: initial.isOpen,
    isCollapsed: initial.isCollapsed,
    isSubmitting: initial.isSubmitting,
    submittedJobId: initial.submittedJobId,
    step: initial.step,
    subStep: initial.subStep,
    webScoutPhase: initial.webScoutPhase,
    webScoutState: initial.webScoutState,
    webScopeMode: initial.webScopeMode,
    webSelectedPaths: initial.webSelectedPaths,
    url: initial.url,
    scoutedUrl: initial.scoutedUrl,
    isReauthorizing: initial.isReauthorizing,
    hasAutoTranslated: initial.hasAutoTranslated,
    recommendedPrefix: initial.recommendedPrefix,
    selectedPrefix: initial.selectedPrefix,
    menuStyle: initial.menuStyle,
    targetLanguage: persistedLang || locale || TRANSLATION_LANGUAGES.DEFAULT_CODE,
    customPrompt: initial.customPrompt,
    aiCondensation: initial.aiCondensation,
    teachingDepth: initial.teachingDepth,
    transcriptionPreset: initial.transcriptionPreset,
    createEdition: initial.createEdition,
    editionLabel: initial.editionLabel,
    ackCost: initial.ackCost,
    versionLabel: initial.versionLabel,
    isPublic: initial.isPublic,
    category: initial.category,
    selectedTags: initial.selectedTags,
    excludedPaths: initial.excludedPaths,
    autoPruneAuxiliary: initial.autoPruneAuxiliary,
    customOutline: initial.customOutline,
    originalOutlineSnapshot: initial.originalOutlineSnapshot,
    hasRecoverableDraft: initial.hasRecoverableDraft,
    recoverableDraftUpdatedAt: initial.recoverableDraftUpdatedAt,
    collapsedCategories: initial.collapsedCategories,
    isOutlineDirty: initial.isOutlineDirty,
    outlineExcluded: initial.outlineExcluded,
    logs: initial.logs,
    ingestSuccessInfo: initial.ingestSuccessInfo,
    ingestFailed: initial.ingestFailed,
    ingestError: initial.ingestError,
    repoPreExisted: initial.repoPreExisted,
    dedupInfo: initial.dedupInfo,
    hasDismissedDedup: initial.hasDismissedDedup,
    scoutSameSource: initial.scoutSameSource,
    draftOutline: initial.draftOutline,
    draftLoading: initial.draftLoading,
    outlineGenError: initial.outlineGenError,
    draftTimings: initial.draftTimings,
    draftScaleDecision: initial.draftScaleDecision,
    isGiantScope: initial.isGiantScope,
    draftUserPrompt: initial.draftUserPrompt,
    draftSteps: initial.draftSteps,
    showConfirmCloseDialog: initial.showConfirmCloseDialog,
    showIngestAbortDialog: initial.showIngestAbortDialog,
    scoutData: initial.scoutData,
    scoutError: initial.scoutError,
  };
}

export function createWizardSetter<K extends keyof ImportWizardData>(key: K) {
  return (value: ImportWizardData[K] | ((prev: ImportWizardData[K]) => ImportWizardData[K])) => {
    useImportWizardStore.setState((s) => ({
      [key]: typeof value === 'function' ? (value as (prev: ImportWizardData[K]) => ImportWizardData[K])(s[key]) : value,
    }) as Partial<ImportWizardData>);
  };
}

function projectWebScoutPhase(state: WebDocScoutSnapshot | null): WebDocScoutPhase {
  if (!state) return 'idle';
  if (state.status === 'loading') return 'scouting';
  if (state.status === 'ready') return 'ready';
  return 'failed';
}

export const wizardFlow = {
  goToStep(step: number): void {
    useImportWizardStore.setState({ step });
  },
  goToStepWithSubStep(step: number, subStep: WizardSubStep): void {
    useImportWizardStore.setState({ step, subStep });
  },
  openAtInput(): void {
    useImportWizardStore.setState({
      isOpen: true,
      step: 1,
      subStep: 'input',
      isSubmitting: false,
      submittedJobId: null,
      draftLoading: false,
      isReauthorizing: false,
    });
  },
  goBackToInput(): void {
    useImportWizardStore.setState({
      step: 1,
      subStep: 'input',
      loading: false,
      webScoutPhase: 'idle',
      scoutError: null,
    });
  },
  resumeFromInput(): boolean {
    const s = useImportWizardStore.getState();
    const trimmedUrl = s.url.trim();
    if (!trimmedUrl) return false;
    if (s.importMode === 'web' && s.webScoutState && s.webScoutState.url === trimmedUrl) {
      useImportWizardStore.setState({
        step: 1,
        subStep: 'web_confirm',
        webScoutPhase: projectWebScoutPhase(s.webScoutState),
        scoutError: null,
      });
      return true;
    }
    if (s.importMode === 'github' && s.scoutData && s.scoutedUrl === trimmedUrl) {
      useImportWizardStore.setState({
        step: 2,
        subStep: 'outline_draft',
        loading: false,
        scoutError: null,
        draftLoading: s.customOutline.length === 0,
      });
      return true;
    }
    return false;
  },
  goBackToScope(): void {
    const s = useImportWizardStore.getState();
    if (s.importMode === 'web') {
      useImportWizardStore.setState({
        step: 1,
        subStep: 'web_confirm',
        webScoutPhase: projectWebScoutPhase(s.webScoutState),
        outlineGenError: null,
        draftLoading: false,
        ingestFailed: false,
        ingestError: null,
      });
      return;
    }
    useImportWizardStore.setState({
      step: 1,
      subStep: 'input',
      outlineGenError: null,
      draftLoading: false,
      ingestFailed: false,
      ingestError: null,
    });
  },
  enterWebConfirm(targetUrl: string, options?: { force?: boolean }): void {
    const s = useImportWizardStore.getState();
    const normalized = targetUrl.trim();
    if (!options?.force && s.webScoutState && s.webScoutState.url === normalized && s.webScoutState.status === 'ready') {
      useImportWizardStore.setState({
        importMode: 'web',
        step: 1,
        subStep: 'web_confirm',
        webScoutPhase: 'ready',
        scoutError: null,
      });
      return;
    }
    useImportWizardStore.setState({
      importMode: 'web',
      step: 1,
      subStep: 'web_confirm',
      webScoutPhase: 'scouting',
      scoutError: null,
      webScoutState: { url: normalized, status: 'loading' },
      webScopeMode: 'recommended',
      webSelectedPaths: [],
    });
  },
  applyWebScoutResult(
    targetUrl: string,
    result: Omit<WebDocScoutSnapshot, 'url'>,
    defaultSelected: string[] = []
  ): void {
    const nextSnapshot: WebDocScoutSnapshot = { ...result, url: targetUrl.trim() };
    const patch: Partial<ImportWizardData> = {
      webScoutState: nextSnapshot,
      webScoutPhase: projectWebScoutPhase(nextSnapshot),
    };
    if (result.status === 'ready') {
      patch.webScopeMode = 'recommended';
      patch.webSelectedPaths = defaultSelected;
    }
    useImportWizardStore.setState(patch);
  },
  setWebScopeMode(mode: 'recommended' | 'all'): void {
    useImportWizardStore.setState({ webScopeMode: mode });
  },
  setWebSelectedPaths(paths: string[]): void {
    useImportWizardStore.setState({ webSelectedPaths: paths });
  },
  toggleWebSelectedPath(path: string): void {
    useImportWizardStore.setState((s) => {
      const exists = s.webSelectedPaths.includes(path);
      return {
        webSelectedPaths: exists
          ? s.webSelectedPaths.filter((p) => p !== path)
          : [...s.webSelectedPaths, path],
      };
    });
  },
  updateTargetLanguage(lang: string): void {
    if (!lang) return;
    persistTargetLanguage(lang);
    useImportWizardStore.setState({ targetLanguage: lang });
  },
  enterOrchestration(): void {
    useImportWizardStore.setState({
      step: 2,
      customOutline: [],
      outlineGenError: null,
      draftLoading: true,
      isOutlineDirty: false,
      originalOutlineSnapshot: null,
      hasRecoverableDraft: false,
      recoverableDraftUpdatedAt: null,
      collapsedCategories: {},
      draftOutline: null,
    });
  },
  handoffToIngest(jobId: string): void {
    useImportWizardStore.setState({
      isSubmitting: false,
      submittedJobId: jobId,
      customOutline: [],
      originalOutlineSnapshot: null,
      draftOutline: null,
      draftLoading: false,
      isOutlineDirty: false,
      hasRecoverableDraft: false,
      outlineExcluded: [],
    });
  },
} as const;

export const wizardSetters = {
  enterOrchestration: wizardFlow.enterOrchestration,
  setIsOpen: createWizardSetter('isOpen'),
  collapseWizard(): void {
    useImportWizardStore.setState({ isCollapsed: true });
  },
  expandWizard(): void {
    useImportWizardStore.setState({ isCollapsed: false });
  },
  setStep: createWizardSetter('step'),
  setSubStep: createWizardSetter('subStep'),
  setImportMode: createWizardSetter('importMode'),
  setWebScoutPhase: createWizardSetter('webScoutPhase'),
  setUrl: createWizardSetter('url'),
  setLoading: createWizardSetter('loading'),
  setIsReauthorizing: createWizardSetter('isReauthorizing'),
  setPrefixLoading: createWizardSetter('prefixLoading'),
  setIsTranslatingOutline: createWizardSetter('isTranslatingOutline'),
  setHasAutoTranslated: createWizardSetter('hasAutoTranslated'),
  setTranslatingIndices: createWizardSetter('translatingIndices'),
  setScoutData: createWizardSetter('scoutData'),
  setUserPrefs: createWizardSetter('userPrefs'),
  setRecommendedPrefix: createWizardSetter('recommendedPrefix'),
  setSelectedPrefix: createWizardSetter('selectedPrefix'),
  setMenuStyle: createWizardSetter('menuStyle'),
  setTargetLanguage: createWizardSetter('targetLanguage'),
  setCustomPrompt: createWizardSetter('customPrompt'),
  setAiCondensation: createWizardSetter('aiCondensation'),
  setTeachingDepth: createWizardSetter('teachingDepth'),
  setTranscriptionPreset: createWizardSetter('transcriptionPreset'),
  setCreateEdition: createWizardSetter('createEdition'),
  setEditionLabel: createWizardSetter('editionLabel'),
  setAckCost: createWizardSetter('ackCost'),
  setVersionLabel: createWizardSetter('versionLabel'),
  setCustomExtensions: createWizardSetter('customExtensions'),
  setIsPublic: createWizardSetter('isPublic'),
  setCategory: createWizardSetter('category'),
  setSelectedTags: createWizardSetter('selectedTags'),
  setCustomTagInput: createWizardSetter('customTagInput'),
  setTagPool: createWizardSetter('tagPool'),
  setCustomOutline: createWizardSetter('customOutline'),
  setOriginalOutlineSnapshot: createWizardSetter('originalOutlineSnapshot'),
  setHasRecoverableDraft: createWizardSetter('hasRecoverableDraft'),
  setRecoverableDraftUpdatedAt: createWizardSetter('recoverableDraftUpdatedAt'),
  setExcludedPaths: createWizardSetter('excludedPaths'),
  setAutoPruneAuxiliary: createWizardSetter('autoPruneAuxiliary'),
  setCollapsedCategories: createWizardSetter('collapsedCategories'),
  setIsOutlineDirty: createWizardSetter('isOutlineDirty'),
  setOutlineExcluded: createWizardSetter('outlineExcluded'),
  setDraftOutline: createWizardSetter('draftOutline'),
  setDraftLoading: createWizardSetter('draftLoading'),
  setOutlineGenError: createWizardSetter('outlineGenError'),
  setDraftTimings: createWizardSetter('draftTimings'),
  setDraftScaleDecision: createWizardSetter('draftScaleDecision'),
  setIsGiantScope: createWizardSetter('isGiantScope'),
  setDraftUserPrompt: createWizardSetter('draftUserPrompt'),
  setShowEmptyCategoryDialog: createWizardSetter('showEmptyCategoryDialog'),
  setEmptyCategoriesCount: createWizardSetter('emptyCategoriesCount'),
  setShowConfirmCloseDialog: createWizardSetter('showConfirmCloseDialog'),
  setShowIngestAbortDialog: createWizardSetter('showIngestAbortDialog'),
  setIngestFailed: createWizardSetter('ingestFailed'),
  setIngestError: createWizardSetter('ingestError'),
  setRepoPreExisted: createWizardSetter('repoPreExisted'),
  setImportScopeMode: createWizardSetter('importScopeMode'),
  setTargetLandingPath: createWizardSetter('targetLandingPath'),
  setParsedUrlInfo: createWizardSetter('parsedUrlInfo'),
  setDedupInfo: createWizardSetter('dedupInfo'),
  setScoutSameSource: createWizardSetter('scoutSameSource'),
  setHasDismissedDedup: createWizardSetter('hasDismissedDedup'),
  setDraggedCatIndex: createWizardSetter('draggedCatIndex'),
  setDraggedFile: createWizardSetter('draggedFile'),
  setDragOverCatIndex: createWizardSetter('dragOverCatIndex'),
  setLogs: createWizardSetter('logs'),
  setScoutSteps: createWizardSetter('scoutSteps'),
  setDraftSteps: createWizardSetter('draftSteps'),
  setIngestSuccessInfo: createWizardSetter('ingestSuccessInfo'),
  setIsSubmitting: createWizardSetter('isSubmitting'),
  setSubmittedJobId: createWizardSetter('submittedJobId'),
  setScoutError: createWizardSetter('scoutError'),
} as const;

export function getWizardLifecycleState(data: ImportWizardData): WizardLifecycleState {
  return projectWizardLifecycleState({
    isOpen: data.isOpen,
    step: data.step,
    isSubmitting: data.isSubmitting,
    submittedJobId: data.submittedJobId,
    ingestSuccessInfo: data.ingestSuccessInfo,
    ingestFailed: data.ingestFailed,
  });
}

export function getWizardCloseAction(data: ImportWizardData): WizardCloseAction {
  return projectWizardCloseAction({
    isOpen: data.isOpen,
    step: data.step,
    isSubmitting: data.isSubmitting,
    submittedJobId: data.submittedJobId,
    ingestSuccessInfo: data.ingestSuccessInfo,
    ingestFailed: data.ingestFailed,
    isOutlineDirty: data.isOutlineDirty,
  });
}

export const SAVED_JOB_LOADING_CAPSULE: WizardCapsuleState = {
  statusKind: 'loading',
  badgeLabel: '构建中',
  detailText: '正在后台入库构建...',
  actionHint: '查看进度',
};

function isCapsuleInputEqual(prev: ImportWizardData, next: ImportWizardData): boolean {
  if (Object.is(prev, next)) return true;
  return (
    prev.isOpen === next.isOpen &&
    prev.step === next.step &&
    prev.loading === next.loading &&
    prev.prefixLoading === next.prefixLoading &&
    prev.draftLoading === next.draftLoading &&
    prev.isSubmitting === next.isSubmitting &&
    prev.submittedJobId === next.submittedJobId &&
    prev.scoutData === next.scoutData &&
    prev.customOutline === next.customOutline &&
    prev.logs === next.logs &&
    prev.ingestSuccessInfo === next.ingestSuccessInfo &&
    prev.ingestFailed === next.ingestFailed &&
    prev.scoutError === next.scoutError &&
    prev.outlineGenError === next.outlineGenError
  );
}

function computeWizardCapsuleState(data: ImportWizardData): WizardCapsuleState {
  return projectWizardCapsuleState({
    isOpen: data.isOpen,
    step: data.step,
    loading: data.loading,
    prefixLoading: data.prefixLoading,
    draftLoading: data.draftLoading,
    isSubmitting: data.isSubmitting,
    submittedJobId: data.submittedJobId,
    scoutData: data.scoutData,
    customOutline: data.customOutline,
    logs: data.logs,
    ingestSuccessInfo: data.ingestSuccessInfo,
    ingestFailed: data.ingestFailed,
    scoutError: data.scoutError,
    outlineGenError: data.outlineGenError,
  });
}

export const getWizardCapsuleState = createMemoizedObjectSelector(
  computeWizardCapsuleState,
  isCapsuleInputEqual
);

export function canProceedToOutline(data: ImportWizardData): boolean {
  if (!data.isOpen || data.loading) return false;
  if (!data.url.trim()) return false;
  if (data.importMode === 'github') {
    return Boolean(data.scoutData && (Array.isArray(data.customOutline) && data.customOutline.length > 0 || data.draftOutline));
  }
  if (data.importMode === 'web') {
    return data.url.trim().startsWith('http://') || data.url.trim().startsWith('https://');
  }
  return false;
}

export function canProceedToIngest(data: ImportWizardData): boolean {
  if (!data.isOpen || data.loading || data.step !== 2) return false;
  if (!data.url.trim()) return false;
  if (data.isTranslatingOutline) return false;
  return Array.isArray(data.customOutline) && data.customOutline.length > 0;
}

