import { create } from 'zustand';
import { ignoreBestEffort } from '@/lib/best-effort';
import { STORAGE_KEYS } from '@/lib/constants';

export interface DashboardKeepAliveSnapshot {
  currentPage: number;
  selectedCategory: string;
  sourceType: 'all' | 'github' | 'webdoc';
  searchQuery: string;
  activeTab: 'all' | 'trending' | 'review' | 'favorites';
  currentSort: string;
  scrollOffset: number;
  savedAt: number;
}

export interface DashboardKeepAliveStoreState {
  snapshot: DashboardKeepAliveSnapshot;
  saveSnapshot: (partial: Partial<DashboardKeepAliveSnapshot>) => void;
  getSnapshot: () => DashboardKeepAliveSnapshot;
  resetSnapshot: () => void;
}

export const DEFAULT_DASHBOARD_SNAPSHOT: DashboardKeepAliveSnapshot = {
  currentPage: 1,
  selectedCategory: 'all',
  sourceType: 'all',
  searchQuery: '',
  activeTab: 'all',
  currentSort: 'hot',
  scrollOffset: 0,
  savedAt: 0,
};

export function readStorageSnapshot(): DashboardKeepAliveSnapshot {
  if (typeof sessionStorage === 'undefined') return { ...DEFAULT_DASHBOARD_SNAPSHOT };
  try {
    const raw = sessionStorage.getItem(STORAGE_KEYS.DASHBOARD_KEEPALIVE_STATE);
    if (!raw) return { ...DEFAULT_DASHBOARD_SNAPSHOT };
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        currentPage:
          typeof parsed.currentPage === 'number' && parsed.currentPage > 0
            ? parsed.currentPage
            : DEFAULT_DASHBOARD_SNAPSHOT.currentPage,
        selectedCategory:
          typeof parsed.selectedCategory === 'string'
            ? parsed.selectedCategory
            : DEFAULT_DASHBOARD_SNAPSHOT.selectedCategory,
        sourceType:
          parsed.sourceType === 'github' || parsed.sourceType === 'webdoc' || parsed.sourceType === 'all'
            ? parsed.sourceType
            : DEFAULT_DASHBOARD_SNAPSHOT.sourceType,
        searchQuery:
          typeof parsed.searchQuery === 'string'
            ? parsed.searchQuery
            : DEFAULT_DASHBOARD_SNAPSHOT.searchQuery,
        activeTab:
          parsed.activeTab === 'favorites' ||
          parsed.activeTab === 'review' ||
          parsed.activeTab === 'trending' ||
          parsed.activeTab === 'all'
            ? parsed.activeTab
            : DEFAULT_DASHBOARD_SNAPSHOT.activeTab,
        currentSort:
          typeof parsed.currentSort === 'string'
            ? parsed.currentSort
            : DEFAULT_DASHBOARD_SNAPSHOT.currentSort,
        scrollOffset:
          typeof parsed.scrollOffset === 'number' && parsed.scrollOffset >= 0
            ? parsed.scrollOffset
            : DEFAULT_DASHBOARD_SNAPSHOT.scrollOffset,
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      };
    }
  } catch {
  }
  return { ...DEFAULT_DASHBOARD_SNAPSHOT };
}

export function writeStorageSnapshot(snapshot: DashboardKeepAliveSnapshot): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(STORAGE_KEYS.DASHBOARD_KEEPALIVE_STATE, JSON.stringify(snapshot));
  } catch {
  }
}

export function purgeStorageSnapshot(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(STORAGE_KEYS.DASHBOARD_KEEPALIVE_STATE);
  } catch {
  }
}

export const useDashboardKeepAliveStore = create<DashboardKeepAliveStoreState>((set, get) => ({
  snapshot: { ...DEFAULT_DASHBOARD_SNAPSHOT },

  saveSnapshot: (partial: Partial<DashboardKeepAliveSnapshot>) => {
    const prev = get().snapshot;
    const next: DashboardKeepAliveSnapshot = {
      ...prev,
      ...partial,
      savedAt: Date.now(),
    };
    set({ snapshot: next });
    writeStorageSnapshot(next);
  },

  getSnapshot: () => {
    const current = get().snapshot;
    if (current.savedAt === 0 && typeof window !== 'undefined') {
      const fromDisk = readStorageSnapshot();
      if (fromDisk.savedAt > 0) {
        set({ snapshot: fromDisk });
        return fromDisk;
      }
    }
    return current;
  },

  resetSnapshot: () => {
    set({ snapshot: { ...DEFAULT_DASHBOARD_SNAPSHOT } });
    purgeStorageSnapshot();
  },
}));

export const dashboardKeepAliveStore = useDashboardKeepAliveStore;

export function getDashboardSnapshot(): DashboardKeepAliveSnapshot {
  try {
    return useDashboardKeepAliveStore.getState().getSnapshot();
  } catch {
    return { ...DEFAULT_DASHBOARD_SNAPSHOT };
  }
}

export function saveDashboardSnapshot(partial: Partial<DashboardKeepAliveSnapshot>): void {
  try {
    useDashboardKeepAliveStore.getState().saveSnapshot(partial);
  } catch {
    ignoreBestEffort();
  }
}
