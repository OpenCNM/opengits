import { create } from 'zustand';
import {
  parseCodeAnchor,
  formatCodeAnchor,
} from '@/lib/code-viewport/line-anchor';

export interface CodeDrawerTarget {
  owner: string;
  repo: string;
  filePath: string;
  sha?: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
}

export interface CodeDrawerStoreState {
  isOpen: boolean;
  target: CodeDrawerTarget | null;

  // Actions
  openDrawer: (target: CodeDrawerTarget) => void;
  closeDrawer: () => void;
  syncFromHash: (
    hash: string,
    defaultContext?: { owner: string; repo: string; sha?: string }
  ) => boolean;
}

export const useCodeDrawerStore = create<CodeDrawerStoreState>((set, get) => ({
  isOpen: false,
  target: null,

  openDrawer: (target: CodeDrawerTarget) => {
    set({
      isOpen: true,
      target,
    });

    if (typeof window !== 'undefined' && target.filePath) {
      const hash = formatCodeAnchor({
        filePath: target.filePath,
        startLine: target.startLine || 1,
        endLine: target.endLine,
      });

      const nextUrl = `${window.location.pathname}${window.location.search}${hash}`;
      window.history.replaceState(null, '', nextUrl);
    }
  },

  closeDrawer: () => {
    set({
      isOpen: false,
      target: null,
    });

    if (typeof window !== 'undefined' && window.location.hash.startsWith('#code:')) {
      const cleanUrl = `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(null, '', cleanUrl);
    }
  },

  syncFromHash: (
    hash: string,
    defaultContext?: { owner: string; repo: string; sha?: string }
  ): boolean => {
    const parsed = parseCodeAnchor(hash);
    if (!parsed || !parsed.filePath || !defaultContext?.owner || !defaultContext?.repo) {
      if (get().isOpen) {
        set({ isOpen: false, target: null });
      }
      return false;
    }

    const current = get().target;
    const isSame =
      get().isOpen &&
      current?.owner === defaultContext.owner &&
      current?.repo === defaultContext.repo &&
      current?.filePath === parsed.filePath &&
      current?.startLine === parsed.range.startLine &&
      current?.endLine === parsed.range.endLine;

    if (isSame) {
      return true;
    }

    set({
      isOpen: true,
      target: {
        owner: defaultContext.owner,
        repo: defaultContext.repo,
        sha: defaultContext.sha,
        filePath: parsed.filePath,
        startLine: parsed.range.startLine,
        endLine: parsed.range.endLine,
      },
    });

    return true;
  },
}));
