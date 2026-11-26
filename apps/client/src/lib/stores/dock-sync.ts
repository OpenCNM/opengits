import { useTutorialDockStore, type MinimizedTutorial } from './transcription-dock-store';
import type { DockTutorialFacts } from '@/lib/state/dock-status-projector';

export function seedDockTutorial(entry: MinimizedTutorial): void {
  useTutorialDockStore.getState().addOrUpdateTutorial(entry);
}

export function syncDockTutorialFromFacts(
  tut: MinimizedTutorial,
  facts: DockTutorialFacts,
  targetUrl?: string
): void {
  useTutorialDockStore.getState().addOrUpdateTutorial({
    ...tut,
    status: facts.dockStatus,
    completedChapters: facts.completedChapters,
    totalChapters: facts.totalChapters > 0 ? facts.totalChapters : tut.totalChapters,
    activeChapterTitle: facts.activeChapterTitle,
    activeDocPath: facts.activeDocPath,
    ...(targetUrl !== undefined ? { url: targetUrl } : {}),
  });
}
