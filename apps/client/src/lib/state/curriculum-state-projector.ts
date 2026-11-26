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

// Terminal DB facts (PROCESSED -> READY, ERROR -> FAILED) are immutable and outrank transient queue/processing lists.
export function projectChapterLifecycleState(
  doc: ChapterDocumentInput,
  options?: ChapterProjectionOptions
): ChapterLifecycleState {
  if (doc.status === DocumentStatus.PROCESSED) {
    return 'READY';
  }

  if (doc.status === DocumentStatus.ERROR) {
    return 'FAILED';
  }

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

  if (doc.transcriptionJob?.status === 'FAILED') {
    return 'FAILED';
  }

  const prioritizedId = options?.prioritizedId;
  if (prioritizedId && (prioritizedId === doc.id || matchDocPath(doc.path, prioritizedId))) {
    return 'PRIORITIZED';
  }

  if (
    doc.transcriptionJob?.status === 'QUEUED' ||
    doc.status === DocumentStatus.UNPROCESSED
  ) {
    return 'QUEUED';
  }

  return 'QUEUED';
}

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

  // Four counters partition all docs, so !ready && !running && !queued implies failedCount === total.
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

// HANDOFF is absorbing once a job exists; never downgrade to FAILED on stream loss.
export function projectWizardLifecycleState(
  input: WizardLifecycleInput
): WizardLifecycleState {
  if (!input.isOpen) {
    return 'IDLE';
  }

  if (Boolean(input.submittedJobId || input.ingestSuccessInfo)) {
    return 'HANDOFF';
  }

  if (input.ingestFailed) {
    return 'FAILED';
  }

  if (input.isSubmitting || input.step === 3) {
    return 'SUBMITTING';
  }

  if (input.step === 2) {
    return 'CURATING';
  }

  return 'DISCOVERING';
}

// Dirty outline confirmation outranks confirm-abort even when ingestFailed is set so edits are not silently lost.
export function projectWizardCloseAction(input: WizardCloseGuardInput): WizardCloseAction {
  if (input.step === 2 && input.isOutlineDirty) {
    return 'confirm-dirty';
  }
  if (input.step === 3 && !input.ingestSuccessInfo && !input.submittedJobId) {
    return 'confirm-abort';
  }
  return 'close';
}

export function projectWizardCapsuleState(input: WizardCapsuleInput): WizardCapsuleState {
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

  if (Boolean(input.ingestSuccessInfo)) {
    return {
      statusKind: 'success',
      badgeLabel: '已就绪',
      detailText: '教程构建完成 · 点击前往阅读',
      actionHint: '前往阅读',
    };
  }

  if (input.step === 3 || input.isSubmitting || Boolean(input.submittedJobId)) {
    const latestLog = input.logs && input.logs.length > 0 ? input.logs[input.logs.length - 1] : '';
    return {
      statusKind: 'loading',
      badgeLabel: '构建中',
      detailText: latestLog ? latestLog.slice(0, 50) : '正在全书转录与入库构建...',
      actionHint: '点击查看进度',
    };
  }

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

