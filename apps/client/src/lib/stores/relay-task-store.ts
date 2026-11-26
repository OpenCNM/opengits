'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { RelaySuccessResult } from '@/components/update/workbench/useUpdateWorkbench';
import {
  deriveRelayTaskPhase,
  type RelayTaskPhase,
} from '@/lib/state/chapter-update-state-projector';

export type { RelayTaskPhase };

export interface ActiveRelayTask {
  owner: string;
  repo: string;
  nodeId: string;
  path: string;
  title: string;
  chapterTitle?: string | null;
  startedAt: number;
  status: RelayTaskPhase;
  result?: RelaySuccessResult | null;
  error?: string | null;
}

export interface RelayTaskStore {
  activeTask: ActiveRelayTask | null;
  isWorkbenchOpen: boolean;
  workbenchTarget: { owner: string; repo: string; nodeId?: string } | null;
  startTask: (task: {
    owner: string;
    repo: string;
    nodeId: string;
    path: string;
    title: string;
    chapterTitle?: string | null;
  }) => void;
  completeTask: (result: RelaySuccessResult) => void;
  failTask: (error?: string) => void;
  dismissTask: () => void;
  setWorkbenchOpen: (open: boolean, target?: { owner: string; repo: string; nodeId?: string }) => void;
}

export const useRelayTaskStore = create<RelayTaskStore>()(
  persist(
    (set) => ({
      activeTask: null,
      isWorkbenchOpen: false,
      workbenchTarget: null,

      startTask: (task) =>
        set({
          activeTask: {
            ...task,
            startedAt: Date.now(),
            status: deriveRelayTaskPhase({ result: null, error: null }),
            result: null,
            error: null,
          },
          workbenchTarget: {
            owner: task.owner,
            repo: task.repo,
            nodeId: task.nodeId,
          },
        }),

      completeTask: (result) =>
        set((state) => {
          if (!state.activeTask) return state;
          return {
            activeTask: {
              ...state.activeTask,
              status: deriveRelayTaskPhase({ result }),
              result,
            },
          };
        }),

      failTask: (error) =>
        set((state) => {
          if (!state.activeTask) return state;
          const resolvedError = error || '转录失败，请重试';
          return {
            activeTask: {
              ...state.activeTask,
              status: deriveRelayTaskPhase({ error: resolvedError }),
              error: resolvedError,
            },
          };
        }),

      dismissTask: () => set({ activeTask: null }),

      setWorkbenchOpen: (open, target) =>
        set((state) => ({
          isWorkbenchOpen: open,
          workbenchTarget: target ?? state.workbenchTarget,
        })),
    }),
    {
      name: 'relay-task-store-v1',
      storage: createJSONStorage(() => (typeof window !== 'undefined' ? localStorage : ({} as any))),
      partialize: (state) => ({
        activeTask: state.activeTask,
        workbenchTarget: state.workbenchTarget,
      }),
    }
  )
);
