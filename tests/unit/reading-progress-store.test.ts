import { describe, it, expect, beforeEach, vi } from 'vitest';

const storeMap = new Map<string, string>();
const localStorageMock = {
  getItem: (k: string) => storeMap.get(k) ?? null,
  setItem: (k: string, v: string) => storeMap.set(k, String(v)),
  removeItem: (k: string) => storeMap.delete(k),
  clear: () => storeMap.clear(),
  length: 0,
  key: (i: number) => Array.from(storeMap.keys())[i] || null,
};

const eventListeners: Record<string, ((e: any) => void)[]> = {};

vi.stubGlobal('localStorage', localStorageMock);
vi.stubGlobal('window', {
  addEventListener: (event: string, cb: (e: any) => void) => {
    eventListeners[event] = eventListeners[event] || [];
    eventListeners[event].push(cb);
  },
  removeEventListener: (event: string, cb: (e: any) => void) => {
    eventListeners[event] = (eventListeners[event] || []).filter((fn) => fn !== cb);
  },
  dispatchEvent: (e: any) => {
    const list = eventListeners[e.type] || [];
    list.forEach((cb) => cb(e));
    return true;
  },
});

describe('M03 [3.1] 仓内隔离阅读进度 Store 与跨 Tab 同步', () => {
  beforeEach(() => {
    storeMap.clear();
  });

  // 🧪 [3.1.1.1 · HIGH] 不同仓库下相同路径 (如 /docs/intro) 互相覆盖阅读进度:
  // AntiPattern: 以纯 path 作为 localStorage 键名
  // DefenseAssertion: 以 `${owner}/${repo}:${path}` 作为唯一复合命名空间存储
  it('3.1.1.1 仓级别前缀隔离：不同仓库下相同路径互不干扰', async () => {
    const { useReadingProgressStore } = await import('@/lib/stores/reading-progress-store');
    useReadingProgressStore.setState({ chapterScores: {}, overallProgress: 0 });

    const store = useReadingProgressStore.getState();

    // 仓库 A 录入 /docs/intro 进度 80
    store.setChapterScore('/docs/intro', 80, 'ownerA/repoA');

    // 仓库 B 录入相同 /docs/intro 路径进度 30
    store.setChapterScore('/docs/intro', 30, 'ownerB/repoB');

    const state = useReadingProgressStore.getState();

    // 验证状态隔离：各自按 repoKey:path 独立落状态
    expect(state.getChapterScore('/docs/intro', 'ownerA/repoA')).toBe(80);
    expect(state.getChapterScore('/docs/intro', 'ownerB/repoB')).toBe(30);

    // 原始 scores 键包含前缀（写入侧与读取侧同口径归一：前导斜杠剥离，键格式为 repoKey:cleanPath）
    expect(state.chapterScores['ownera/repoa:docs/intro']).toBe(80);
    expect(state.chapterScores['ownerb/repob:docs/intro']).toBe(30);
  });

  // 🧪 [3.1.2.1 · MEDIUM] 慢速滚动同步事件覆盖了已 100% 完成的阅读记录:
  // AntiPattern: 直接赋值覆盖 targetProgress
  // DefenseAssertion: 更新时取 Math.max(existing, next) 确保进度严格单调不倒退
  it('3.1.2.1 Monotonic 单调递增：低分更新不可回退已完成进度', async () => {
    const { useReadingProgressStore } = await import('@/lib/stores/reading-progress-store');
    useReadingProgressStore.setState({ chapterScores: {}, overallProgress: 0 });

    const store = useReadingProgressStore.getState();

    // 读完 100%
    store.setChapterScore('guide.md', 100, 'o/r');
    expect(useReadingProgressStore.getState().getChapterScore('guide.md', 'o/r')).toBe(100);

    // 慢速滚动上报 45%，不能倒退
    store.setChapterScore('guide.md', 45, 'o/r');
    expect(useReadingProgressStore.getState().getChapterScore('guide.md', 'o/r')).toBe(100);

    // initScores 合并 DB 同样遵循 Math.max 保证不倒退
    store.initScores({ 'guide.md': 60 }, 50, 'o/r');
    expect(useReadingProgressStore.getState().getChapterScore('guide.md', 'o/r')).toBe(100);
  });

  // 🧪 [3.1.3.1 · LOW] Tab A 读完章节后 Tab B 侧边栏仍显示未读:
  // AntiPattern: 未挂载 window.addEventListener('storage')
  // DefenseAssertion: 捕获 StorageEvent 触发 Zustand 跨窗口状态同步
  it('3.1.3.1 跨标签页 StorageEvent 监听与单调合并：Tab B 捕获事件后自动更新 Store 且不倒退', async () => {
    const { useReadingProgressStore, mergeMonotonicScores } = await import('@/lib/stores/reading-progress-store');
    useReadingProgressStore.setState({
      chapterScores: { 'ownera/repoa:/docs/intro': 50 },
      overallProgress: 50,
    });

    // 1. 验证单调合并纯函数
    const current = {
      'o/r:chap1.md': 100,
      'o/r:chap2.md': 40,
    };
    const incoming = {
      'o/r:chap2.md': 85, // 远端更高
      'o/r:chap1.md': 20, // 远端更低（不应被倒退）
      'o/r:chap3.md': 50, // 新增章节
    };

    const { merged, hasDiff } = mergeMonotonicScores(current, incoming);
    expect(hasDiff).toBe(true);
    expect(merged['o/r:chap1.md']).toBe(100);
    expect(merged['o/r:chap2.md']).toBe(85);
    expect(merged['o/r:chap3.md']).toBe(50);

    // 2. 验证实际已挂载的 window.addEventListener('storage') 回调触发
    const storageListeners = eventListeners['storage'] || [];
    expect(storageListeners.length).toBeGreaterThan(0);

    // 模拟远端 Tab A 读完 intro 达到 100% 并新增 outro 60%
    const storagePayload = {
      key: 'reading-progress-store-v1',
      newValue: JSON.stringify({
        state: {
          chapterScores: {
            'ownera/repoa:/docs/intro': 100,
            'ownera/repoa:/docs/outro': 60,
          },
          overallProgress: 80,
        },
      }),
    };

    for (const listener of storageListeners) {
      listener(storagePayload);
    }

    const updated = useReadingProgressStore.getState();
    expect(updated.getChapterScore('/docs/intro', 'ownera/repoa')).toBe(100);
    expect(updated.getChapterScore('/docs/outro', 'ownera/repoa')).toBe(60);
    expect(updated.overallProgress).toBe(80);
  });

  it('shouldPurgeReadingProgressKey 按仓前缀精准清理', async () => {
    const { shouldPurgeReadingProgressKey } = await import('@/lib/stores/reading-progress-store');

    expect(shouldPurgeReadingProgressKey('reading_pos_v2_owner/repo:chap.md', 'owner/repo')).toBe(true);
    expect(shouldPurgeReadingProgressKey('owner/repo:chap.md', 'owner/repo')).toBe(true);
    expect(shouldPurgeReadingProgressKey('other/repo:chap.md', 'owner/repo')).toBe(false);
  });

  it('3.1.4.1 分数值域钳制与非法类型过滤：防御 NaN, Infinity, 负数与超界数值', async () => {
    const { useReadingProgressStore } = await import('@/lib/stores/reading-progress-store');
    useReadingProgressStore.setState({ chapterScores: {}, overallProgress: 0 });
    const store = useReadingProgressStore.getState();

    // 尝试传入 NaN 与负数与超大数值
    store.setChapterScore('bad1.md', NaN as any, 'o/r');
    expect(store.getChapterScore('bad1.md', 'o/r')).toBe(0);

    store.setChapterScore('bad2.md', -50, 'o/r');
    expect(store.getChapterScore('bad2.md', 'o/r')).toBe(0);

    store.setChapterScore('bad3.md', 150, 'o/r');
    expect(store.getChapterScore('bad3.md', 'o/r')).toBe(100);

    store.setChapterScore('bad4.md', Infinity as any, 'o/r');
    expect(store.getChapterScore('bad4.md', 'o/r')).toBe(0);
  });

  it('3.1.4.2 原型污染防御：mergeMonotonicScores 坚决忽略 __proto__, constructor 与 prototype', async () => {
    const { mergeMonotonicScores } = await import('@/lib/stores/reading-progress-store');

    const current: Record<string, number> = { 'o/r:safe.md': 10 };
    const maliciousIncoming = JSON.parse(
      '{"__proto__": 99, "constructor": 99, "prototype": 99, "o/r:safe.md": 50}'
    );

    const { merged, hasDiff } = mergeMonotonicScores(current, maliciousIncoming);
    expect(hasDiff).toBe(true);
    expect(merged['o/r:safe.md']).toBe(50);
    expect(Object.prototype.hasOwnProperty.call(merged, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(merged, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(merged, 'prototype')).toBe(false);
  });

  it('3.1.4.3 clearRepoScores 仓级隔离清空：仅清空目标仓，保留其余仓库进度', async () => {
    const { useReadingProgressStore } = await import('@/lib/stores/reading-progress-store');
    useReadingProgressStore.setState({
      chapterScores: {
        'repo1:/intro': 100,
        'repo2:/intro': 90,
      },
      overallProgress: 95,
    });

    useReadingProgressStore.getState().clearRepoScores('repo1');

    const state = useReadingProgressStore.getState();
    expect(state.getChapterScore('/intro', 'repo1')).toBe(0);
    expect(state.getChapterScore('/intro', 'repo2')).toBe(90);
  });
});
