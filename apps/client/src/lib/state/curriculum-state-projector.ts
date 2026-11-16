import { DocumentStatus } from '@/lib/constants';
import { matchDocPath } from '@/lib/doc-path';
import type {
  CourseLifecycleState,
  ChapterLifecycleState,
  ChapterDocumentInput,
  ChapterProjectionOptions,
  CourseLifecycleProjection,
  WizardLifecycleState,
  WizardLifecycleInput,
  WizardCloseAction,
  WizardCloseGuardInput,
  WizardCapsuleState,
  WizardCapsuleInput,
} from './curriculum-lifecycle-contract';

/**
 * Pure projection of a chapter's lifecycle state from physical facts.
 *
 * Invariants & Rules:
 * 1. Terminal Fact Invariant (CRITICAL): If doc.status === 'PROCESSED',
 *    it MUST immediately and immutably project to 'READY'.
 *    Never allow PRIORITIZED, RUNNING, or QUEUED to override a physically processed document.
 * 2. If doc.status === 'PROCESSING' or transcriptionJob?.status === 'RUNNING'
 *    or explicitly contained in processingDocIds / currentProcessingId, project to 'RUNNING'.
 * 3. If doc.status === 'ERROR' or transcriptionJob?.status === 'FAILED', project to 'FAILED'.
 * 4. If user explicitly prioritized (prioritizedId matches doc.id or doc.path) and not running,
 *    project to 'PRIORITIZED'.
 * 5. If transcriptionJob?.status === 'QUEUED' or doc.status === 'UNPROCESSED', project to 'QUEUED'.
 */
export function projectChapterLifecycleState(
  doc: ChapterDocumentInput,
  options?: ChapterProjectionOptions
): ChapterLifecycleState {
  // 1. Terminal Success Fact Invariant (CRITICAL):
  // If physically processed, it MUST immediately and immutably project to 'READY'.
  if (doc.status === DocumentStatus.PROCESSED) {
    return 'READY';
  }

  // 2. Terminal Error Fact:
  // If physically marked as ERROR, it MUST immediately project to 'FAILED'.
  // Transient processing lists or stale running job records must never mask a physical database error.
  if (doc.status === DocumentStatus.ERROR) {
    return 'FAILED';
  }

  // 3. Active Running Execution State
  const isQueuedJob = doc.transcriptionJob?.status === 'QUEUED';
  const isJobRunning = doc.transcriptionJob?.status === 'RUNNING';
  const isInProcessingList = Boolean(
    (options?.processingDocIds && options.processingDocIds.includes(doc.id)) ||
    (options?.currentProcessingId && doc.id === options.currentProcessingId)
  );
  if (
    doc.status === DocumentStatus.PROCESSING ||
    isJobRunning ||
    (!isQueuedJob && isInProcessingList)
  ) {
    return 'RUNNING';
  }

  // 4. Job-level Failure
  if (doc.transcriptionJob?.status === 'FAILED') {
    return 'FAILED';
  }

  // 5. User Prioritized State
  const prioritizedId = options?.prioritizedId;
  if (prioritizedId && (prioritizedId === doc.id || matchDocPath(doc.path, prioritizedId))) {
    return 'PRIORITIZED';
  }

  // 6. Queued / Waiting State
  if (
    doc.transcriptionJob?.status === 'QUEUED' ||
    doc.status === DocumentStatus.UNPROCESSED
  ) {
    return 'QUEUED';
  }

  return 'QUEUED';
}

/**
 * Projects the overall course state and progress percentage based on all chapters.
 *
 * Rules:
 * - Empty course: IDLE
 * - All chapters ready (readyCount === total): IDLE (isCompleted: true)
 * - All chapters failed (failedCount === total) or no work pending with 0 ready: FAILED
 * - isPaused: PAUSED (if not complete and not completely failed)
 * - At least one chapter ready, but not all: PARTIAL_READY
 * - 0 chapters ready, transcribing: TRANSCRIBING
 */
export function projectCourseLifecycleState(
  documents: readonly ChapterDocumentInput[],
  isPaused: boolean = false,
  options?: ChapterProjectionOptions
): CourseLifecycleProjection {
  const total = documents.length;
  if (total === 0) {
    return {
      state: 'IDLE',
      total: 0,
      processed: 0,
      readyCount: 0,
      runningCount: 0,
      queuedCount: 0,
      failedCount: 0,
      progressPct: 0,
      isCompleted: false,
    };
  }

  let readyCount = 0;
  let runningCount = 0;
  let queuedCount = 0;
  let failedCount = 0;

  for (const doc of documents) {
    const chapterState = projectChapterLifecycleState(doc, options);
    switch (chapterState) {
      case 'READY':
        readyCount++;
        break;
      case 'RUNNING':
        runningCount++;
        break;
      case 'QUEUED':
      case 'PRIORITIZED':
        queuedCount++;
        break;
      case 'FAILED':
        failedCount++;
        break;
    }
  }

  const isCompleted = total > 0 && readyCount === total;
  const progressPct = total > 0 ? Math.round((readyCount / total) * 100) : 0;

  let state: CourseLifecycleState;

  // 四计数器（ready/running/queued+prioritized/failed）对全集做划分，
  // 「无 ready/running/queued 且 failed>0」必然蕴含 failedCount === total，无需重复子句
  if (isCompleted) {
    state = 'IDLE';
  } else if (failedCount === total) {
    state = 'FAILED';
  } else if (isPaused) {
    state = 'PAUSED';
  } else if (readyCount > 0) {
    state = 'PARTIAL_READY';
  } else {
    state = 'TRANSCRIBING';
  }

  return {
    state,
    total,
    processed: readyCount,
    readyCount,
    runningCount,
    queuedCount,
    failedCount,
    progressPct,
    isCompleted,
  };
}

/**
 * Pure projection of wizard lifecycle state machine:
 * DISCOVERING -> CURATING -> SUBMITTING -> HANDOFF | FAILED
 *
 * Rules (precedence-ordered):
 * - !isOpen: IDLE
 * - submittedJobId || ingestSuccessInfo: HANDOFF — Job 已入库或已成功，服务端存续为最高事实；
 *   即使跟随流断开（ingestFailed 误置），也绝不降级为 FAILED（任务在后台继续执行）
 * - ingestFailed: FAILED — 仅指派发失败且无任何 Job 存续的终局
 * - isSubmitting || step === 3: SUBMITTING (job submission dispatch or step 3 executing)
 * - step === 2: CURATING (outline structure & chapter editing)
 * - step === 1 (or other open state): DISCOVERING (URL parsing, repository analysis, directory picking)
 */
export function projectWizardLifecycleState(
  input: WizardLifecycleInput
): WizardLifecycleState {
  if (!input.isOpen) {
    return 'IDLE';
  }

  // 1. Job 已派发入库或已成功：HANDOFF 为吸收态（absorbing），吞掉后续一切失败信号
  if (Boolean(input.submittedJobId || input.ingestSuccessInfo)) {
    return 'HANDOFF';
  }

  // 2. 派发失败终局：无 Job ID、无成功信息，仅剩失败标记
  if (input.ingestFailed) {
    return 'FAILED';
  }

  // 3. Active submission dispatch in-flight or submission step
  if (input.isSubmitting || input.step === 3) {
    return 'SUBMITTING';
  }

  // 4. Step 2 Outline Curation & Pedagogical Structuring
  if (input.step === 2) {
    return 'CURATING';
  }

  // 5. Step 1 Repository Discovery & Exploration
  return 'DISCOVERING';
}

/**
 * 向导关闭守卫（纯投影）：把 handleCloseRequest 的裸字段三连判收敛为单一可测试决策。
 *
 * 规则（优先级序，与既有交互行为逐字等价）：
 * - step === 2 且大纲有未保存编辑 → confirm-dirty（脏数据确认优先级最高，
 *   即使残留 ingestFailed 也不允许静默丢弃用户编辑）
 * - step === 3 且无任何 Job 存续（未 HANDOFF、未成功）→ confirm-abort
 *   （含 FAILED 态：确认后的 resetWizard 可能 DELETE 未存续的仓，必须显式确认）
 * - 其余（IDLE / DISCOVERING / HANDOFF / 干净的 CURATING）→ 直接关闭
 */
export function projectWizardCloseAction(input: WizardCloseGuardInput): WizardCloseAction {
  if (input.step === 2 && input.isOutlineDirty) {
    return 'confirm-dirty';
  }
  if (input.step === 3 && !input.ingestSuccessInfo && !input.submittedJobId) {
    return 'confirm-abort';
  }
  return 'close';
}

/**
 * 胶囊外显状态机投影器 (Pure State Machine Projector)
 *
 * 依据向导内部事实，确定性推导出外部胶囊的交互相位、徽标及详情文案：
 * - 失败态：ingestFailed 或 scoutError → 'error'
 * - 成功态：ingestSuccessInfo → 'success'
 * - Step 3 构建态：isSubmitting 或提交中 → 'loading' (构建中)
 * - Step 2 编排态：
 *     - draftLoading 或大纲为空 → 'loading' (规划中，伴随 Loader2)
 *     - 大纲已就绪 (customOutline.length > 0 且 !draftLoading) → 'action_required' (待确认，提示章节数，指示待操作)
 * - Step 1 探测态：
 *     - loading/prefixLoading → 'loading' (分析中)
 *     - scoutData 存在 → 'action_required' (待选择目录)
 *     - 其余 → 'action_required' (待输入 URL)
 */
export function projectWizardCapsuleState(input: WizardCapsuleInput): WizardCapsuleState {
  // 1. 终态错误判定
  if (input.ingestFailed) {
    return {
      statusKind: 'error',
      badgeLabel: '构建异常',
      detailText: '入库构建中断 · 点击查看处理',
      actionHint: '点击处理',
    };
  }
  if (input.scoutError) {
    return {
      statusKind: 'error',
      badgeLabel: '分析失败',
      detailText: '仓库架构解析失败 · 点击查看',
      actionHint: '点击查看',
    };
  }

  // 2. 终态成功判定
  if (Boolean(input.ingestSuccessInfo)) {
    return {
      statusKind: 'success',
      badgeLabel: '已就绪',
      detailText: '教程构建完成 · 点击前往阅读',
      actionHint: '前往阅读',
    };
  }

  // 3. Step 3: 构建与入库调度中 (SUBMITTING)
  if (input.step === 3 || input.isSubmitting || Boolean(input.submittedJobId)) {
    const latestLog = input.logs && input.logs.length > 0 ? input.logs[input.logs.length - 1] : '';
    return {
      statusKind: 'loading',
      badgeLabel: '构建中',
      detailText: latestLog ? latestLog.slice(0, 50) : '正在全书转录与入库构建...',
      actionHint: '点击查看进度',
    };
  }

  // 4. Step 2: 大纲编排阶段 (CURATING)
  if (input.step === 2) {
    if (input.outlineGenError) {
      const isNetworkErr = typeof input.outlineGenError === 'string' &&
        /网络|network|timeout|超时|500|502|504|离线|offline|failed to fetch/i.test(input.outlineGenError);
      return {
        statusKind: 'error',
        badgeLabel: isNetworkErr ? '网络中断' : '规划异常',
        detailText: isNetworkErr
          ? '大纲规划网络连接异常 · 点击查看并重试'
          : '大纲自适应规划中断 · 点击查看处理',
        actionHint: '点击处理',
      };
    }
    const isGenerating = Boolean(input.draftLoading || !input.customOutline || input.customOutline.length === 0);
    if (isGenerating) {
      return {
        statusKind: 'loading',
        badgeLabel: '规划中',
        detailText: '基于代码架构自适应规划大纲中...',
        actionHint: '正在计算',
      };
    }
    const chapterCount = input.customOutline?.length ?? 0;
    return {
      statusKind: 'action_required',
      badgeLabel: '待确认',
      detailText: `大纲已就绪 (${chapterCount} 章) · 待确认编排`,
      actionHint: '点击继续下一步',
    };
  }

  // 5. Step 1: 仓库探测阶段 (DISCOVERING)
  if (input.loading || input.prefixLoading) {
    return {
      statusKind: 'loading',
      badgeLabel: '分析中',
      detailText: '正在探测仓库事实与目录拓扑...',
      actionHint: '正在分析',
    };
  }
  if (input.scoutData) {
    return {
      statusKind: 'action_required',
      badgeLabel: '待操作',
      detailText: '代码架构已识别 · 待确认目标目录',
      actionHint: '点击选择目录',
    };
  }

  return {
    statusKind: 'action_required',
    badgeLabel: '待输入',
    detailText: '待输入仓库或文档 URL',
    actionHint: '点击继续',
  };
}

