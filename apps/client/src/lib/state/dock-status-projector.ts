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

export interface DockTutorialFacts {
  dockStatus: DockTutorialStatus;
  completedChapters: number;
  totalChapters: number;
  activeChapterTitle: string | null;
  activeDocPath: string | null;
}

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
