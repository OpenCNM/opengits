import type { DocumentStatus } from '@/lib/constants';
import type { TranscriptionJobStatus } from '@/lib/state/status-vocabularies';

/**
 * Top-level coarse-grained course lifecycle state.
 */
export type CourseLifecycleState =
  | 'IDLE'
  | 'TRANSCRIBING'
  | 'PAUSED'
  | 'PARTIAL_READY'
  | 'FAILED';

/**
 * Fine-grained per-chapter lifecycle state projected purely from physical facts.
 */
export type ChapterLifecycleState =
  | 'READY'
  | 'RUNNING'
  | 'QUEUED'
  | 'PRIORITIZED'
  | 'FAILED';

/**
 * Job-level factual input for chapter transcription.
 */
export interface ChapterJobInput {
  status?: TranscriptionJobStatus | null;
  savedChunks?: number | null;
  totalChunks?: number | null;
  queuePosition?: number | null;
  etaSeconds?: number | null;
  claimedAt?: string | null;
  createdAt?: string | null;
  startedAt?: number | null;
  progress?: number | null;
  step?: string | null;
}

/**
 * Document-level factual input for curriculum projection.
 */
export interface ChapterDocumentInput {
  id: string;
  path: string;
  title?: string | null;
  /** 文档物理状态（Prisma DocumentStatus 单一来源，四成员联合） */
  status: DocumentStatus;
  errorMessage?: string | null;
  transcriptionJob?: ChapterJobInput | null;
  /**
   * 虚拟章节事实：大纲存在但 Document 表无物理行的占位符（id 形如 `outline-<path>`）。
   * 投影器按 QUEUED 参与（JIT 待转录），但消费端严禁对其发起插队/重试写操作。
   */
  isVirtual?: boolean;
}

/**
 * Contextual options for chapter lifecycle projection.
 */
export interface ChapterProjectionOptions {
  prioritizedId?: string | null;
  currentProcessingId?: string | null;
  processingDocIds?: readonly string[] | null;
}

/**
 * Ledger / Evidence input representing transcription token budget and credit ledger.
 */
export interface CurriculumLedgerInput {
  transcriptionTokens?: number;
  transcriptionCreditsEarned?: number;
  dailyRemainingCalls?: number | null;
  totalSpentCredits?: number;
  isDailyCapReached?: boolean;
}

/**
 * Course-level lifecycle projection result.
 */
export interface CourseLifecycleProjection {
  state: CourseLifecycleState;
  total: number;
  processed: number;
  readyCount: number;
  runningCount: number;
  queuedCount: number;
  failedCount: number;
  progressPct: number;
  isCompleted: boolean;
}

/**
 * Top-level coarse-grained wizard actor lifecycle state.
 * FAILED 仅指「任务派发失败、无服务端 Job 存续」——一旦 Job 已入库（HANDOFF），
 * 跟随流断开不代表任务失败，严禁降级投影为 FAILED。
 */
export type WizardLifecycleState =
  | 'IDLE'
  | 'DISCOVERING'
  | 'CURATING'
  | 'SUBMITTING'
  | 'HANDOFF'
  | 'FAILED';

/**
 * Input facts for projecting wizard lifecycle state.
 */
export interface WizardLifecycleInput {
  isOpen: boolean;
  step: number;
  isSubmitting?: boolean;
  submittedJobId?: string | null;
  ingestSuccessInfo?: unknown | null;
  ingestFailed?: boolean;
}

/** 向导关闭请求的确定性守卫动作（纯投影，供 handleCloseRequest 消费） */
export type WizardCloseAction = 'close' | 'confirm-dirty' | 'confirm-abort';

/** 关闭守卫输入：生命周期事实 + 大纲脏标记 */
export interface WizardCloseGuardInput extends WizardLifecycleInput {
  isOutlineDirty?: boolean;
}

/**
 * 胶囊外显状态机：同步向导内部状态至外部胶囊
 * - 'loading': 系统正在执行高熵计算/异步请求（如大纲规划中、代码探测中、构建中）
 * - 'action_required': 系统已就绪，等待用户下一步介入（如大纲已规划完毕待确认、目录待确认）
 * - 'success': 全流程已就绪
 * - 'error': 异常中断，等待用户点击查看处理
 */
export type WizardCapsuleStatusKind = 'loading' | 'action_required' | 'success' | 'error';

export interface WizardCapsuleState {
  statusKind: WizardCapsuleStatusKind;
  /** 简明阶段徽标，如 "规划中" | "待确认" | "构建中" | "已就绪" | "异常" */
  badgeLabel: string;
  /** 胶囊当前描述详情 */
  detailText: string;
  /** 胶囊操作指引 */
  actionHint: string;
}

export interface WizardCapsuleInput {
  isOpen: boolean;
  step: number;
  loading?: boolean;
  prefixLoading?: boolean;
  draftLoading?: boolean;
  isSubmitting?: boolean;
  submittedJobId?: string | null;
  scoutData?: unknown | null;
  customOutline?: readonly unknown[];
  logs?: readonly string[];
  ingestSuccessInfo?: unknown | null;
  ingestFailed?: boolean;
  scoutError?: unknown | null;
  outlineGenError?: string | null;
}

