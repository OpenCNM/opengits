import { describe, expect, it, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { useDashboardQueryParams } from '@/components/home/hooks/useDashboardQueryParams';
import { useDashboardKeepAliveStore } from '@/lib/stores/dashboard-keepalive-store';

let mockSearchParams = new URLSearchParams();
const mockRouter = {
  push: vi.fn(),
  replace: vi.fn(),
};

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParams,
}));

describe('useDashboardQueryParams (KeepAlive integration & Hydration Safety)', () => {
  const mockStorage = new Map<string, string>();

  beforeEach(() => {
    mockStorage.clear();
    mockSearchParams = new URLSearchParams();
    vi.clearAllMocks();

    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => mockStorage.get(k) ?? null,
      setItem: (k: string, v: string) => mockStorage.set(k, String(v)),
      removeItem: (k: string) => mockStorage.delete(k),
      clear: () => mockStorage.clear(),
    });

    const replaceStateMock = vi.fn();
    vi.stubGlobal('window', {
      location: {
        href: 'http://localhost/',
        search: '',
      },
      history: {
        replaceState: replaceStateMock,
        state: null,
      },
    });

    useDashboardKeepAliveStore.getState().resetSnapshot();
  });

  /** 模拟 SSR 服务端同步渲染（Frame 0） */
  function renderSSRResult(options: { selectedCategory: string; initialActiveTab?: string; initialSort?: string }) {
    let captured: ReturnType<typeof useDashboardQueryParams> | null = null;
    function TestComponent() {
      captured = useDashboardQueryParams(options);
      return React.createElement('div', null, `Page: ${captured.currentPage}`);
    }
    renderToString(React.createElement(TestComponent));
    return captured!;
  }

  /** 模拟客户端首屏水合与生命周期挂载（Frame 0 -> Frame 1 Effect 恢复） */
  function renderClientHook(initialOptions: { selectedCategory: string; initialActiveTab?: string; initialSort?: string }) {
    let options = initialOptions;
    let captured: ReturnType<typeof useDashboardQueryParams> | null = null;
    const stateMap = new Map<number, any>();
    const refMap = new Map<number, any>();
    const effectsQueue: Array<() => void> = [];
    let stateIdx = 0;
    let refIdx = 0;
    let isRunning = false;

    const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

    function run() {
      stateIdx = 0;
      refIdx = 0;
      effectsQueue.length = 0;

      const prevH = internals?.H;
      internals.H = {
        useState: (init: any) => {
          const id = stateIdx++;
          if (!stateMap.has(id)) {
            stateMap.set(id, typeof init === 'function' ? init() : init);
          }
          const state = stateMap.get(id);
          const setState = (action: any) => {
            const next = typeof action === 'function' ? action(stateMap.get(id)) : action;
            stateMap.set(id, next);
            if (!isRunning) {
              run();
            }
          };
          return [state, setState];
        },
        useRef: (init: any) => {
          const id = refIdx++;
          if (!refMap.has(id)) {
            refMap.set(id, { current: init });
          }
          return refMap.get(id);
        },
        useCallback: (fn: any) => fn,
        useEffect: (cb: any) => {
          effectsQueue.push(cb);
        },
      };

      try {
        isRunning = true;
        captured = useDashboardQueryParams(options);
      } finally {
        isRunning = false;
        internals.H = prevH;
      }
    }

    // 1. 初次执行（模拟 Frame 0）
    run();

    // 2. 触发挂载副作用（模拟 Frame 1）
    const effectsToRun = [...effectsQueue];
    for (const eff of effectsToRun) {
      eff();
    }

    // 3. 副作用更新后重渲染
    run();

    return {
      get current() {
        return captured!;
      },
      rerender(newOptions: { selectedCategory: string; initialActiveTab?: string; initialSort?: string }) {
        options = newOptions;
        run();
        const effs = [...effectsQueue];
        for (const eff of effs) {
          eff();
        }
        run();
      },
    };
  }

  it('SSR 确定性：默认无 URL 参数且无缓存时，currentPage 初始化为 1，activeTab 为 all', () => {
    const result = renderSSRResult({ selectedCategory: 'all' });
    expect(result.currentPage).toBe(1);
    expect(result.activeTab).toBe('all');
  });

  it('SSR 确定性：即使 KeepAlive 快照有历史数据，SSR 首帧也严格保持确定性默认值（杜绝 Hydration Mismatch）', () => {
    useDashboardKeepAliveStore.getState().saveSnapshot({
      currentPage: 4,
      activeTab: 'trending',
      selectedCategory: 'Rust',
    });

    const result = renderSSRResult({ selectedCategory: 'all' });
    // SSR 阶段必须渲染默认值，与客户端首帧完全同构，禁止因 client-only storage 产生 VDOM 漂移
    expect(result.currentPage).toBe(1);
    expect(result.activeTab).toBe('all');
  });

  it('当 URL 携带 ?page=3 时，优先从 URL 读取 currentPage = 3', () => {
    mockSearchParams.set('page', '3');
    const result = renderSSRResult({ selectedCategory: 'all' });
    expect(result.currentPage).toBe(3);
  });

  it('客户端挂载后无缝恢复：当 URL 无 page 参数但 KeepAlive 快照中记录了 currentPage = 4 时，无缝恢复第 4 页', () => {
    useDashboardKeepAliveStore.getState().saveSnapshot({
      currentPage: 4,
      activeTab: 'trending',
    });

    const hook = renderClientHook({ selectedCategory: 'all' });
    expect(hook.current.currentPage).toBe(4);
    expect(hook.current.activeTab).toBe('trending');
  });

  it('调用 setCurrentPage 时同步更新 KeepAlive 快照并静默替换 history URL', () => {
    const hook = renderClientHook({ selectedCategory: 'all' });
    expect(hook.current.currentPage).toBe(1);

    hook.current.setCurrentPage(5);

    const snapshot = useDashboardKeepAliveStore.getState().getSnapshot();
    expect(snapshot.currentPage).toBe(5);
    expect(hook.current.currentPage).toBe(5);

    expect(window.history.replaceState).toHaveBeenCalled();
  });

  it('KeepAlive 记录的排序与 Tab 能够在挂载后无缝恢复', () => {
    useDashboardKeepAliveStore.getState().saveSnapshot({
      activeTab: 'review',
      currentSort: 'newest',
    });

    const hook = renderClientHook({ selectedCategory: 'all' });
    expect(hook.current.activeTab).toBe('review');
    expect(hook.current.currentSort).toBe('newest');
  });

  it('handleSortChange 会同步更新 KeepAlive 快照中的 currentSort 并推送到路由', () => {
    const hook = renderClientHook({ selectedCategory: 'all' });
    hook.current.handleSortChange('az');

    const snapshot = useDashboardKeepAliveStore.getState().getSnapshot();
    expect(snapshot.currentSort).toBe('az');
    expect(hook.current.currentSort).toBe('az');
    expect(mockRouter.push).toHaveBeenCalledWith('/?sort=az');
  });

  it('用户主动切换分类时重置页码为 1', () => {
    const hook = renderClientHook({ selectedCategory: 'all' });
    hook.current.setCurrentPage(3);
    expect(hook.current.currentPage).toBe(3);

    hook.rerender({ selectedCategory: 'Frontend' });
    expect(hook.current.currentPage).toBe(1);
  });

  it('sourceType 初始化与 setSourceType 行为：更新快照、重置页码、路由同步', () => {
    const hook = renderClientHook({ selectedCategory: 'all' });
    expect(hook.current.sourceType).toBe('all');

    hook.current.setCurrentPage(3);
    expect(hook.current.currentPage).toBe(3);

    hook.current.setSourceType('webdoc');
    expect(hook.current.sourceType).toBe('webdoc');
    expect(hook.current.currentPage).toBe(1);

    const snapshot = useDashboardKeepAliveStore.getState().getSnapshot();
    expect(snapshot.sourceType).toBe('webdoc');
    expect(mockRouter.replace).toHaveBeenCalledWith('/?source=webdoc', { scroll: false });
  });

  it('当 URL 携带 ?source=github 时，初始化 sourceType 为 github', () => {
    mockSearchParams.set('source', 'github');
    const hook = renderClientHook({ selectedCategory: 'all' });
    expect(hook.current.sourceType).toBe('github');
  });

  it('KeepAlive 恢复第 2 页且快照包含已选分类时，挂载与父级分类水合过程中页码严格保持第 2 页，不被误判重置', () => {
    useDashboardKeepAliveStore.getState().saveSnapshot({
      currentPage: 2,
      selectedCategory: 'AI',
    });

    // 模拟首帧按 SSR 规范挂载 'all'，随之父级组件由 useEffect 水合推入 'AI'
    const hook = renderClientHook({ selectedCategory: 'all' });
    expect(hook.current.currentPage).toBe(2);

    hook.rerender({ selectedCategory: 'AI' });
    // 首屏分类与快照对齐，绝不误触第 1 页重置
    expect(hook.current.currentPage).toBe(2);

    // 随后用户在界面上主动切换到新分类 'Systems'，必须正常重置到第 1 页
    hook.rerender({ selectedCategory: 'Systems' });
    expect(hook.current.currentPage).toBe(1);
  });

  it('当从快照恢复 currentPage > 1 时，静默同步替换 history 状态，为 OAuth 回跳提供完整 URL', () => {
    useDashboardKeepAliveStore.getState().saveSnapshot({
      currentPage: 3,
    });

    renderClientHook({ selectedCategory: 'all' });
    expect(window.history.replaceState).toHaveBeenCalled();
  });
});
