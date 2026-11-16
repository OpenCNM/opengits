/**
 * Dock 写入唯一 facade（写权限收敛点）。
 *
 * `addOrUpdateTutorial` 的调用权仅限本模块——向导种子、章节大看板收起、胶囊轮询
 * 三类写入方一律经由此处，配合 tests/unit/architecture-skeleton.test.ts 的
 * arch 守卫（全仓只允许本文件引用 addOrUpdateTutorial）形成物理隔离。
 */
import { useTutorialDockStore, type MinimizedTutorial } from './transcription-dock-store';
import type { DockTutorialFacts } from '@/lib/state/dock-status-projector';

/** 种子写入：任务刚入库（向导提交 / 大看板收起），status 由调用方事实推导 */
export function seedDockTutorial(entry: MinimizedTutorial): void {
  useTutorialDockStore.getState().addOrUpdateTutorial(entry);
}

/**
 * 事实同步写入：胶囊轮询把服务端文档事实投影后写回 Dock。
 * targetUrl 由调用方计算（含讲法 query 与活跃章直达路径），缺省保留原 url。
 */
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
