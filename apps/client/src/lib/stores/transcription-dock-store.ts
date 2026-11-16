'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { STORAGE_KEYS } from '@/lib/constants';
import type { DockTutorialStatus } from '@/lib/state/status-vocabularies';

export interface MinimizedTutorial {
  id: string; // `${owner}/${repo}` 或 `${owner}/${repo}:${edition}` (以教程仓库及讲法为唯一维度)
  owner: string;
  repo: string;
  edition?: string | null; // 讲法版本标识，如 "deepseek" 或 null/undefined 代表基础讲法
  title: string; // 教程名称，如 "Llms From Scratch"
  url: string; // 最新阅读/停留章节 URL (包含 query 比如 ?edition=xxx)，方便重新进入
  status: DockTutorialStatus;
  startedAt: number;
  activeChapterTitle?: string | null; // 当前正在转录的章节名称
  activeDocPath?: string | null; // 当前正在转录或待转录的章节物理路径
  completedChapters: number; // 已转录就绪章节数
  totalChapters: number; // 教程总章节数
  updatedAt: number;
}

export interface TutorialDockState {
  tutorials: MinimizedTutorial[];
  isOpen: boolean;

  setIsOpen: (open: boolean) => void;
  addOrUpdateTutorial: (tutorial: MinimizedTutorial) => void;
  removeTutorial: (id: string) => void;
  clearCompleted: () => void;
  getTutorial: (id: string) => MinimizedTutorial | undefined;
}

export const useTutorialDockStore = create<TutorialDockState>()(
  persist(
    (set, get) => ({
      tutorials: [],
      isOpen: false,

      setIsOpen: (isOpen) => set({ isOpen }),
      addOrUpdateTutorial: (input) => {
        set((state) => {
          const index = state.tutorials.findIndex((t) => t.id === input.id);
          let nextList: MinimizedTutorial[];
          if (index >= 0) {
            const existing = state.tutorials[index];
            const hasChanged =
              existing.status !== input.status ||
              existing.completedChapters !== input.completedChapters ||
              existing.totalChapters !== input.totalChapters ||
              (existing.activeChapterTitle ?? null) !== (input.activeChapterTitle ?? null) ||
              (existing.activeDocPath ?? null) !== (input.activeDocPath ?? null) ||
              existing.url !== input.url ||
              existing.title !== input.title ||
              (existing.edition ?? null) !== (input.edition ?? null) ||
              existing.owner !== input.owner ||
              existing.repo !== input.repo;

            if (!hasChanged) {
              return state;
            }

            nextList = [...state.tutorials];
            nextList[index] = {
              ...existing,
              ...input,
              updatedAt: Date.now(),
            };
          } else {
            nextList = [{ ...input, updatedAt: Date.now() }, ...state.tutorials];
          }
          return { tutorials: nextList };
        });
      },

      removeTutorial: (id) =>
        set((state) => ({
          tutorials: state.tutorials.filter((t) => t.id !== id),
        })),

      clearCompleted: () =>
        set((state) => ({
          tutorials: state.tutorials.filter((t) => t.status !== 'PROCESSED'),
        })),

      getTutorial: (id) => get().tutorials.find((t) => t.id === id),
    }),
    {
      name: STORAGE_KEYS.TRANSCRIPTION_DOCK_TASKS,
      storage: createJSONStorage(() => {
        if (typeof window !== 'undefined' && window.localStorage) {
          return localStorage;
        }
        return {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
        };
      }),
      partialize: (state) => ({
        tutorials: state.tutorials,
      }),
    }
  )
);
