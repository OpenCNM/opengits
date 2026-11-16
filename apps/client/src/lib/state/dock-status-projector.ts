import {
  projectChapterLifecycleState,
  projectCourseLifecycleState,
} from './curriculum-state-projector';
import type {
  ChapterDocumentInput,
  CourseLifecycleState,
} from './curriculum-lifecycle-contract';
import type { DockTutorialStatus } from './status-vocabularies';
import { assertNever } from './exhaustive';

/**
 * Dock 悬浮胶囊教程级事实投影（纯函数）：
 * 从服务端 ingest-status 返回的文档事实，一次性投影出胶囊所需的全部派生字段，
 * 取代此前散落在 TranscriptionDockCapsule 轮询与 UninitializedChapter 中的两套手写判定。
 */
export interface DockTutorialFacts {
  dockStatus: DockTutorialStatus;
  completedChapters: number;
  totalChapters: number;
  activeChapterTitle: string | null;
  activeDocPath: string | null;
}

/**
 * 状态映射规则（与既有交互语义对齐，两处写入方统一为同一套）：
 * - 全书完结（isCompleted）或空课程（docs.length === 0）→ 'PROCESSED'
 * - 存在失败章且无任何活跃/排队工作 → 'ERROR'（后台停滞+出错的悲观信号）
 * - 无运行中、无已完成、无失败、仍有排队 → 'QUEUED'（刚入库、尚未被 worker 认领）
 * - 其余（转录中/部分完成）→ 'PROCESSING'
 */
export function projectDockTutorialFacts(
  docs: readonly ChapterDocumentInput[]
): DockTutorialFacts {
  if (docs.length === 0) {
    return {
      dockStatus: 'QUEUED',
      completedChapters: 0,
      totalChapters: 0,
      activeChapterTitle: null,
      activeDocPath: null,
    };
  }

  const course = projectCourseLifecycleState(docs, false);

  // 活跃章：优先运行中，其次队首排队章（数组序，与原 find 语义一致）
  const activeDoc =
    docs.find((d) => projectChapterLifecycleState(d) === 'RUNNING') ??
    docs.find((d) => projectChapterLifecycleState(d) === 'QUEUED') ??
    null;

  const hasActiveWork = course.runningCount > 0 || course.queuedCount > 0;

  let dockStatus: DockTutorialStatus;
  if (course.isCompleted) {
    dockStatus = 'PROCESSED';
  } else if (course.failedCount > 0 && !hasActiveWork) {
    dockStatus = 'ERROR';
  } else if (
    course.runningCount === 0 &&
    course.readyCount === 0 &&
    course.failedCount === 0
  ) {
    dockStatus = 'QUEUED';
  } else {
    dockStatus = 'PROCESSING';
  }

  return {
    dockStatus,
    completedChapters: course.readyCount,
    totalChapters: course.total,
    activeChapterTitle: activeDoc
      ? (activeDoc.title || activeDoc.path.split('/').pop() || null)
      : null,
    activeDocPath: activeDoc?.path ?? null,
  };
}

/** 仅从课程宏观状态映射 Dock 展示态（消费方已持有课程投影时使用；穷尽性守卫） */
export function dockStatusFromCourseLifecycle(state: CourseLifecycleState): DockTutorialStatus {
  switch (state) {
    case 'IDLE':
      return 'PROCESSED';
    case 'FAILED':
      return 'ERROR';
    case 'TRANSCRIBING':
    case 'PARTIAL_READY':
    case 'PAUSED':
      return 'PROCESSING';
    default:
      return assertNever(state, 'dockStatusFromCourseLifecycle');
  }
}
