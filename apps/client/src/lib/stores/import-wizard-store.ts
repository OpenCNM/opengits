import { create } from 'zustand';
import { TRANSLATION_LANGUAGES } from '@/lib/constants';
import { DEFAULT_TRANSCRIPTION_PRESET_ID } from '@/lib/transcription-presets';
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

/**
 * 导入向导状态机数据层（P3-1）。
 *
 * 此前向导的 67 个字段散落在 ImportWizardProvider 的独立 useState 中，
 * resetWizard 需要手工记忆并逐个调用 ~45 个 setter——每新增一个状态都要
 * 记得来这里补一行，漏一个即跨会话状态泄漏。
 *
 * 现收敛为单一数据对象 + INITIAL 工厂 + 稳定 setter 工厂：
 * - Context 充当兼容壳（业务函数与 value 形状不变，消费方零迁移）；
 * - setter 在模块加载时创建一次，引用恒定，可安全进入消费方依赖数组；
 * - 非序列化句柄（AbortController/订阅句柄）仍留在 Provider 的 ref 中。
 */

import type { WebDocScoutPhase } from '@/lib/import-wizard/webdoc-scope';
import type { ModuleTab } from '@/lib/schemas/webdoc-topology';

export type WizardSubStep = 'input' | 'directory_confirm' | 'outline_draft' | 'web_confirm';

/** WebDoc 嗅探与范围选择的持久化快照（提升至 Store，与 GitHub scoutData 同级存活） */
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
  /** 收起态：构建/编排中用户最小化向导为悬浮胶囊（Dialog 隐藏，Provider 与 SSE 订阅存活）。
   * 与关闭语义严格分离——收起不触发确认弹窗、不中断任务；点击胶囊恢复。 */
  isCollapsed: boolean;
  step: number;
  subStep: WizardSubStep;
  importMode: 'github' | 'web';
  /** WebDoc 确认流内嗅探子态（驱动横向步骤条：输入 -> 嗅探 -> 确认目录 -> 抓取） */
  webScoutPhase: WebDocScoutPhase;
  /** WebDoc 嗅探快照与勾选状态（跨返回/重进持久化，不再随组件卸载丢失） */
  webScoutState: WebDocScoutSnapshot | null;
  webScopeMode: 'recommended' | 'all';
  webSelectedPaths: string[];
  url: string;
  /** 本轮已成功探测的标准化 URL（用于区分“仅修改语言/深度偏好”与“更换仓库/站点链接”） */
  scoutedUrl: string;
  loading: boolean;
  isReauthorizing: boolean;
  prefixLoading: boolean;
  isTranslatingOutline: boolean;
  hasAutoTranslated: boolean;
  translatingIndices: Set<string>;
  // 强类型 scout 客户端消费产物
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

  // Phase 5a: 粗纲(turbo)交互确认
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
  /** 本轮向导开始前该仓库是否已存在（取消清理时不得删除既有教程） */
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

  /** 提交调度态：正在向后端创建并派发 ingest job（SUBMITTING 阶段） */
  isSubmitting: boolean;
  /** 已完成派发入库的 Job ID（进入 HANDOFF 阶段，杜绝重复创建或悬挂草稿） */
  submittedJobId: string | null;

  scoutError: {
    status?: string;
    error?: string;
    diagnosticDescription?: string;
    suggestedFormat?: string;
    httpStatus?: number;
  } | null;
}

/** 字段默认值（与原 useState 初始值逐一对应） */
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
    // 默认 'ai'（对齐默认转录预设 standard 教学解读）；当预设选为 faithful（原文直读）时联动设为 'native'
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

/** 单例 store：整个向导任意时刻只有一个实例在用 */
export const useImportWizardStore = create<ImportWizardData>(() => createInitialWizardData());

/**
 * resetWizard 的重置快照：与原手工逐 setter 重置的字段集合逐一对应
 * （刻意不含 loading/prefixLoading/isTranslatingOutline/translatingIndices/userPrefs/
 *  importMode/targetLandingPath/parsedUrlInfo/tagPool/拖拽三态/scoutSteps/
 *  showEmptyCategoryDialog/emptyCategoriesCount/customTagInput —— 原实现即不重置）。
 */
export function createWizardResetPatch(locale?: string | null): Partial<ImportWizardData> {
  const initial = createInitialWizardData(locale);
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
    targetLanguage: locale || TRANSLATION_LANGUAGES.DEFAULT_CODE,
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

/** 字段级 setter：签名兼容 React 的 Dispatch<SetStateAction<T>>（支持函数式更新） */
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

/**
 * 流程转移（显式 phase 语义）：step/subStep 是一对联合状态，
 * 分两次 set 会产生「新 step + 旧 subStep」的中间态渲染；本表保证原子成对转移。
 * 新增流程节点时在此扩展，而不是在组件里散落 setStep/setSubStep 组合。
 */
export const wizardFlow = {
  /** 单步前进/后退：仅 step 变化，subStep 保持（如 outline 内部翻页） */
  goToStep(step: number): void {
    useImportWizardStore.setState({ step });
  },
  /** 跨段转移：step 与 subStep 原子成对更新 */
  goToStepWithSubStep(step: number, subStep: WizardSubStep): void {
    useImportWizardStore.setState({ step, subStep });
  },
  /** 打开向导：回到输入起点 */
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
  /**
   * 从目录确认 / 查重 / 编排页返回第一步输入与偏好配置：
   * 刻意保留已探测结果（scoutData / scoutedUrl / webScoutState / 勾选状态），
   * 修改目标语言、教学深度等正交偏好后可免重跑探测直接继续。
   */
  goBackToInput(): void {
    useImportWizardStore.setState({
      step: 1,
      subStep: 'input',
      loading: false,
      webScoutPhase: 'idle',
      scoutError: null,
    });
  },
  /**
   * 在 URL 未变更时，从第一步输入页免重跑探测直接恢复到目录确认页（GitHub / WebDoc 统一入口）。
   * 返回 true 表示命中缓存并已原子跳转；false 表示需要发起新探测。
   */
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
        step: 1,
        subStep: 'directory_confirm',
        loading: false,
        scoutError: null,
      });
      return true;
    }
    return false;
  },
  /**
   * 从 Step 2 编排或 Step 3 失败回退到各自的范围确认页（GitHub 目录确认 / WebDoc 目录确认）。
   */
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
      });
      return;
    }
    useImportWizardStore.setState({
      step: 1,
      subStep: 'directory_confirm',
      outlineGenError: null,
      draftLoading: false,
      ingestFailed: false,
    });
  },
  /**
   * 进入 WebDoc 目录确认阶段：同 URL 已就绪时复用缓存快照，避免返回修改后重复嗅探。
   */
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
  /** 原子写入 WebDoc 嗅探结果并同步步骤条阶段与默认勾选目录 */
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
  /** 正交更新目标语言（不清空或失效已探测的仓库拓扑快照） */
  updateTargetLanguage(lang: string): void {
    if (!lang) return;
    useImportWizardStore.setState({ targetLanguage: lang });
  },
  /**
   * 进入步骤 2（大纲规划/编排）：原子初始化大纲生成上下文，清理上一阶段/历史弹窗残留变量
   */
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
  /**
   * 提交成功进入 HANDOFF 阶段：原子清理临时大纲草稿与脏状态，
   * 移交全局转录任务跟踪，杜绝向导状态残留与内存泄漏。
   */
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


/**
 * 模块加载时创建一次的稳定 setter 表：引用恒定，
 * 可安全进入消费方 useEffect 依赖数组与 Context value。
 */
export const wizardSetters = {
  enterOrchestration: wizardFlow.enterOrchestration,
  setIsOpen: createWizardSetter('isOpen'),
  /** 收起向导为悬浮胶囊（任务后台继续，SSE 不断） */
  collapseWizard(): void {
    useImportWizardStore.setState({ isCollapsed: true });
  },
  /** 从悬浮胶囊恢复向导弹窗（若已离开首页则由胶囊导航回首页后调用） */
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

/**
 * 推导顶层向导状态机生命周期 (WizardActor Lifecycle State)
 * 物理契约: IDLE -> DISCOVERING -> CURATING -> SUBMITTING -> HANDOFF(吸收态) | FAILED
 */
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

/**
 * 推导向导关闭守卫动作（纯投影，handleCloseRequest 的单一决策源）
 */
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

/**
 * 推导胶囊外显状态机（双端记忆化纯投影选择器，UnifiedTaskDock 及 ImportJobCapsule 的单一决策源）
 * 输入/输出双端引用恒等，消除 React useSyncExternalStore getServerSnapshot 循环死循环风险
 */
export const getWizardCapsuleState = createMemoizedObjectSelector(
  computeWizardCapsuleState,
  isCapsuleInputEqual
);

/**
 * 校验向导是否满足从 Step 1 进入 Step 2 (编排大纲) 的前置充要条件
 */
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

/**
 * 校验向导是否满足从 Step 2 进入 Step 3 (触发构建) 的前置充要条件
 */
export function canProceedToIngest(data: ImportWizardData): boolean {
  if (!data.isOpen || data.loading || data.step !== 2) return false;
  if (!data.url.trim()) return false;
  if (data.isTranslatingOutline) return false;
  return Array.isArray(data.customOutline) && data.customOutline.length > 0;
}

