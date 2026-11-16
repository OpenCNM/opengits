import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  useDashboardKeepAliveStore,
  dashboardKeepAliveStore,
  getDashboardSnapshot,
  saveDashboardSnapshot,
  readStorageSnapshot,
  writeStorageSnapshot,
  purgeStorageSnapshot,
  DEFAULT_DASHBOARD_SNAPSHOT,
} from '@/lib/stores/dashboard-keepalive-store';
import { STORAGE_KEYS } from '@/lib/constants';

describe('useDashboardKeepAliveStore (Vue-like KeepAlive cache)', () => {
  const mockStorage = new Map<string, string>();

  beforeEach(() => {
    mockStorage.clear();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => mockStorage.get(k) ?? null,
      setItem: (k: string, v: string) => mockStorage.set(k, String(v)),
      removeItem: (k: string) => mockStorage.delete(k),
      clear: () => mockStorage.clear(),
    });
    useDashboardKeepAliveStore.getState().resetSnapshot();
  });

  it('初始状态为默认快照 (第1页, all 分类, 0 滚动)', () => {
    const snapshot = useDashboardKeepAliveStore.getState().snapshot;
    expect(snapshot.currentPage).toBe(1);
    expect(snapshot.selectedCategory).toBe('all');
    expect(snapshot.scrollOffset).toBe(0);
    expect(snapshot.activeTab).toBe('all');
    expect(snapshot.currentSort).toBe('hot');
  });

  it('saveSnapshot 能够更新内存快照并同步持久化到 sessionStorage', () => {
    useDashboardKeepAliveStore.getState().saveSnapshot({
      currentPage: 3,
      selectedCategory: 'Rust',
      scrollOffset: 450,
      activeTab: 'trending',
    });

    const snapshot = useDashboardKeepAliveStore.getState().getSnapshot();
    expect(snapshot.currentPage).toBe(3);
    expect(snapshot.selectedCategory).toBe('Rust');
    expect(snapshot.scrollOffset).toBe(450);
    expect(snapshot.activeTab).toBe('trending');
    expect(snapshot.savedAt).toBeGreaterThan(0);

    const storedRaw = mockStorage.get(STORAGE_KEYS.DASHBOARD_KEEPALIVE_STATE);
    expect(storedRaw).toBeDefined();
    const stored = JSON.parse(storedRaw!);
    expect(stored.currentPage).toBe(3);
    expect(stored.selectedCategory).toBe('Rust');
    expect(stored.scrollOffset).toBe(450);
  });

  it('增量更新时保留先前快照中的其他字段', () => {
    useDashboardKeepAliveStore.getState().saveSnapshot({
      currentPage: 2,
      selectedCategory: 'Python',
      scrollOffset: 300,
    });

    // 仅更新页码
    useDashboardKeepAliveStore.getState().saveSnapshot({
      currentPage: 4,
    });

    const snapshot = useDashboardKeepAliveStore.getState().getSnapshot();
    expect(snapshot.currentPage).toBe(4);
    expect(snapshot.selectedCategory).toBe('Python');
    expect(snapshot.scrollOffset).toBe(300);
  });

  it('resetSnapshot 清理内存并移除 sessionStorage 缓存', () => {
    useDashboardKeepAliveStore.getState().saveSnapshot({
      currentPage: 5,
      scrollOffset: 999,
    });
    expect(mockStorage.has(STORAGE_KEYS.DASHBOARD_KEEPALIVE_STATE)).toBe(true);

    useDashboardKeepAliveStore.getState().resetSnapshot();

    const snapshot = useDashboardKeepAliveStore.getState().snapshot;
    expect(snapshot.currentPage).toBe(1);
    expect(snapshot.scrollOffset).toBe(0);
    expect(mockStorage.has(STORAGE_KEYS.DASHBOARD_KEEPALIVE_STATE)).toBe(false);
  });

  it('readStorageSnapshot 在遇到畸形 JSON 时遵循失效封闭原则安全回退默认值', () => {
    mockStorage.set(STORAGE_KEYS.DASHBOARD_KEEPALIVE_STATE, 'invalid-json{{{');
    const fallback = readStorageSnapshot();
    expect(fallback.currentPage).toBe(DEFAULT_DASHBOARD_SNAPSHOT.currentPage);
    expect(fallback.selectedCategory).toBe(DEFAULT_DASHBOARD_SNAPSHOT.selectedCategory);
    expect(fallback.scrollOffset).toBe(0);
  });

  it('readStorageSnapshot 安全过滤异常负数或不合法页码', () => {
    mockStorage.set(
      STORAGE_KEYS.DASHBOARD_KEEPALIVE_STATE,
      JSON.stringify({
        currentPage: -10,
        scrollOffset: -50,
        activeTab: 'unknown_tab',
      })
    );
    const parsed = readStorageSnapshot();
    expect(parsed.currentPage).toBe(1);
    expect(parsed.scrollOffset).toBe(0);
    expect(parsed.activeTab).toBe('all');
  });

  it('dashboardKeepAliveStore 别名与安全工具函数 getDashboardSnapshot/saveDashboardSnapshot 正常运作', () => {
    saveDashboardSnapshot({
      currentPage: 3,
      selectedCategory: 'Go',
      scrollOffset: 120,
    });

    const snapshot = getDashboardSnapshot();
    expect(snapshot.currentPage).toBe(3);
    expect(snapshot.selectedCategory).toBe('Go');
    expect(snapshot.scrollOffset).toBe(120);

    expect(dashboardKeepAliveStore.getState().snapshot.currentPage).toBe(3);
  });
});
