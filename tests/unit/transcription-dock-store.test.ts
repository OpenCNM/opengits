import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useTutorialDockStore } from '@/lib/stores/transcription-dock-store';

const storeMap = new Map<string, string>();
const localStorageMock = {
  getItem: (k: string) => storeMap.get(k) ?? null,
  setItem: (k: string, v: string) => storeMap.set(k, String(v)),
  removeItem: (k: string) => storeMap.delete(k),
  clear: () => storeMap.clear(),
  length: 0,
  key: (i: number) => Array.from(storeMap.keys())[i] || null,
};

vi.stubGlobal('localStorage', localStorageMock);
vi.stubGlobal('window', { localStorage: localStorageMock });

describe('tutorial-dock-store (后台转录以整个教程为维度的收起与悬浮胶囊)', () => {
  beforeEach(() => {
    storeMap.clear();
    useTutorialDockStore.setState({
      tutorials: [],
      isOpen: false,
    });
  });

  it('支持以整个教程/仓库为唯一维度，将转录中的教程一键收起至悬浮胶囊', () => {
    const store = useTutorialDockStore.getState();

    store.addOrUpdateTutorial({
      id: 'RASBT/Llms-From-Scratch',
      owner: 'RASBT',
      repo: 'Llms-From-Scratch',
      title: 'Llms From Scratch',
      url: '/docs/RASBT/Llms-From-Scratch/04-kv-cache',
      status: 'PROCESSING',
      startedAt: Date.now(),
      activeChapterTitle: '第 4 章：KV缓存与高效推理注意力变体',
      completedChapters: 3,
      totalChapters: 9,
      updatedAt: Date.now(),
    });

    const state = useTutorialDockStore.getState();
    expect(state.tutorials).toHaveLength(1);
    expect(state.tutorials[0].id).toBe('RASBT/Llms-From-Scratch');
    expect(state.tutorials[0].title).toBe('Llms From Scratch');
    expect(state.tutorials[0].activeChapterTitle).toBe('第 4 章：KV缓存与高效推理注意力变体');
    expect(state.tutorials[0].completedChapters).toBe(3);
    expect(state.tutorials[0].totalChapters).toBe(9);
  });

  it('支持多个不同教程同时收起进入胶囊队列（多教程并发转录跟踪）', () => {
    const store = useTutorialDockStore.getState();

    store.addOrUpdateTutorial({
      id: 'RASBT/Llms-From-Scratch',
      owner: 'RASBT',
      repo: 'Llms-From-Scratch',
      title: 'Llms From Scratch',
      url: '/docs/RASBT/Llms-From-Scratch/04-kv-cache',
      status: 'PROCESSING',
      startedAt: Date.now(),
      activeChapterTitle: '第 4 章：KV缓存',
      completedChapters: 3,
      totalChapters: 9,
      updatedAt: Date.now(),
    });

    store.addOrUpdateTutorial({
      id: 'karpathy/minGPT',
      owner: 'karpathy',
      repo: 'minGPT',
      title: 'minGPT',
      url: '/docs/karpathy/minGPT/01-intro',
      status: 'QUEUED',
      startedAt: Date.now(),
      activeChapterTitle: '第 1 章：minGPT 入门',
      completedChapters: 0,
      totalChapters: 5,
      updatedAt: Date.now(),
    });

    const state = useTutorialDockStore.getState();
    expect(state.tutorials).toHaveLength(2);
    expect(state.tutorials.map((t) => t.id)).toEqual([
      'karpathy/minGPT',
      'RASBT/Llms-From-Scratch',
    ]);
  });

  it('重复收起/更新同一教程时按 ID 幂等更新状态与章节进度，不产生重复条目', () => {
    const store = useTutorialDockStore.getState();

    store.addOrUpdateTutorial({
      id: 'RASBT/Llms-From-Scratch',
      owner: 'RASBT',
      repo: 'Llms-From-Scratch',
      title: 'Llms From Scratch',
      url: '/docs/RASBT/Llms-From-Scratch/04-kv-cache',
      status: 'PROCESSING',
      startedAt: 1000,
      activeChapterTitle: '第 4 章：KV缓存',
      completedChapters: 3,
      totalChapters: 9,
      updatedAt: 1000,
    });

    store.addOrUpdateTutorial({
      id: 'RASBT/Llms-From-Scratch',
      owner: 'RASBT',
      repo: 'Llms-From-Scratch',
      title: 'Llms From Scratch',
      url: '/docs/RASBT/Llms-From-Scratch/05-moe',
      status: 'PROCESSING',
      startedAt: 1000,
      activeChapterTitle: '第 5 章：前沿架构探索——MoE',
      completedChapters: 4,
      totalChapters: 9,
      updatedAt: 2000,
    });

    const state = useTutorialDockStore.getState();
    expect(state.tutorials).toHaveLength(1);
    expect(state.tutorials[0].completedChapters).toBe(4);
    expect(state.tutorials[0].activeChapterTitle).toBe('第 5 章：前沿架构探索——MoE');
    expect(state.tutorials[0].url).toBe('/docs/RASBT/Llms-From-Scratch/05-moe');
  });

  it('当更新内容与既有教程物理事实一致时，不触发 Store 更新与新数组引用（防死循环与无谓渲染）', () => {
    const store = useTutorialDockStore.getState();

    store.addOrUpdateTutorial({
      id: 'RASBT/Llms-From-Scratch',
      owner: 'RASBT',
      repo: 'Llms-From-Scratch',
      title: 'Llms From Scratch',
      url: '/docs/RASBT/Llms-From-Scratch/04-kv-cache',
      status: 'PROCESSING',
      startedAt: 1000,
      activeChapterTitle: '第 4 章：KV缓存',
      completedChapters: 3,
      totalChapters: 9,
      updatedAt: 1000,
    });

    const prevTutorials = useTutorialDockStore.getState().tutorials;

    // 再次以相同事实调用 addOrUpdateTutorial（如后台轮询返回相同数据）
    store.addOrUpdateTutorial({
      id: 'RASBT/Llms-From-Scratch',
      owner: 'RASBT',
      repo: 'Llms-From-Scratch',
      title: 'Llms From Scratch',
      url: '/docs/RASBT/Llms-From-Scratch/04-kv-cache',
      status: 'PROCESSING',
      startedAt: 1000,
      activeChapterTitle: '第 4 章：KV缓存',
      completedChapters: 3,
      totalChapters: 9,
      updatedAt: 1000,
    });

    const currentTutorials = useTutorialDockStore.getState().tutorials;
    // 引用保持恒定，Zustand 不会向订阅者广播变更
    expect(currentTutorials).toBe(prevTutorials);
  });

  it('支持移出教程与清空全量已完成教程', () => {
    const store = useTutorialDockStore.getState();

    store.addOrUpdateTutorial({
      id: 'RASBT/Llms-From-Scratch',
      owner: 'RASBT',
      repo: 'Llms-From-Scratch',
      title: 'Llms From Scratch',
      url: '/docs/RASBT/Llms-From-Scratch',
      status: 'PROCESSED',
      startedAt: Date.now(),
      completedChapters: 9,
      totalChapters: 9,
      updatedAt: Date.now(),
    });

    store.addOrUpdateTutorial({
      id: 'karpathy/minGPT',
      owner: 'karpathy',
      repo: 'minGPT',
      title: 'minGPT',
      url: '/docs/karpathy/minGPT',
      status: 'PROCESSING',
      startedAt: Date.now(),
      completedChapters: 2,
      totalChapters: 5,
      updatedAt: Date.now(),
    });

    expect(useTutorialDockStore.getState().tutorials).toHaveLength(2);

    // 清空已完成教程
    store.clearCompleted();
    const afterClear = useTutorialDockStore.getState();
    expect(afterClear.tutorials).toHaveLength(1);
    expect(afterClear.tutorials[0].id).toBe('karpathy/minGPT');

    // 移出剩余教程
    store.removeTutorial('karpathy/minGPT');
    const afterRemove = useTutorialDockStore.getState();
    expect(afterRemove.tutorials).toHaveLength(0);
  });

  it('消费即闭环：已就绪教程被阅读消费后移出 Store，返回首页时不再提示', () => {
    const store = useTutorialDockStore.getState();

    store.addOrUpdateTutorial({
      id: 'RASBT/Llms-From-Scratch',
      owner: 'RASBT',
      repo: 'Llms-From-Scratch',
      title: 'Llms From Scratch',
      url: '/docs/RASBT/Llms-From-Scratch',
      status: 'PROCESSED',
      startedAt: Date.now(),
      completedChapters: 9,
      totalChapters: 9,
      updatedAt: Date.now(),
    });

    expect(useTutorialDockStore.getState().tutorials).toHaveLength(1);

    // 模拟用户在胶囊中点击进入该教程阅读
    const tut = useTutorialDockStore.getState().tutorials[0];
    if (tut.status === 'PROCESSED') {
      store.removeTutorial(tut.id);
    }

    // 验证队列中已无该教程，返回 Home 页面时胶囊隐身
    expect(useTutorialDockStore.getState().tutorials).toHaveLength(0);
  });

  it('支持同仓库不同讲法（edition）多版本共存与携带 ?edition= 参数精准重新进入', () => {
    const store = useTutorialDockStore.getState();

    // 1. 基础版本收起入队
    store.addOrUpdateTutorial({
      id: 'RASBT/Llms-From-Scratch',
      owner: 'RASBT',
      repo: 'Llms-From-Scratch',
      edition: null,
      title: 'Llms From Scratch',
      url: '/docs/RASBT/Llms-From-Scratch/01-intro',
      status: 'PROCESSED',
      startedAt: Date.now(),
      activeChapterTitle: '第 1 章：引言',
      completedChapters: 9,
      totalChapters: 9,
      updatedAt: Date.now(),
    });

    // 2. DeepSeek R1 讲法版本收起入队
    store.addOrUpdateTutorial({
      id: 'RASBT/Llms-From-Scratch:deepseek-r1',
      owner: 'RASBT',
      repo: 'Llms-From-Scratch',
      edition: 'deepseek-r1',
      title: 'Llms From Scratch (DeepSeek R1 讲法)',
      url: '/docs/RASBT/Llms-From-Scratch/04-kv-cache?edition=deepseek-r1',
      status: 'PROCESSING',
      startedAt: Date.now(),
      activeChapterTitle: '第 4 章：KV缓存与注意力优化',
      completedChapters: 2,
      totalChapters: 9,
      updatedAt: Date.now(),
    });

    const state = useTutorialDockStore.getState();
    // 两个不同讲法版本互不覆盖，各自独立留存
    expect(state.tutorials).toHaveLength(2);

    const baseTut = state.tutorials.find((t) => t.id === 'RASBT/Llms-From-Scratch');
    const editionTut = state.tutorials.find((t) => t.id === 'RASBT/Llms-From-Scratch:deepseek-r1');

    expect(baseTut).toBeDefined();
    expect(baseTut?.edition).toBeNull();
    expect(baseTut?.url).toBe('/docs/RASBT/Llms-From-Scratch/01-intro');

    expect(editionTut).toBeDefined();
    expect(editionTut?.edition).toBe('deepseek-r1');
    expect(editionTut?.url).toBe('/docs/RASBT/Llms-From-Scratch/04-kv-cache?edition=deepseek-r1');
    expect(editionTut?.title).toContain('DeepSeek R1');
  });

  it('单仓与全局胶囊让位协同：全局仅含当前教程时不让位给空气，杜绝收起后再次进入胶囊消失死锁', () => {
    const store = useTutorialDockStore.getState();

    // 假设当前教程已收起进全局 dock
    store.addOrUpdateTutorial({
      id: 'RASBT/Llms-From-Scratch',
      owner: 'RASBT',
      repo: 'Llms-From-Scratch',
      edition: null,
      title: 'Llms From Scratch',
      url: '/docs/RASBT/Llms-From-Scratch/04-kv-cache',
      status: 'PROCESSING',
      startedAt: Date.now(),
      activeChapterTitle: '第 4 章：KV缓存',
      completedChapters: 3,
      totalChapters: 9,
      updatedAt: Date.now(),
    });

    const dockTutorials = useTutorialDockStore.getState().tutorials;

    // 当用户正在访问 RASBT/Llms-From-Scratch (基础讲法) 时：
    const currentOwner = 'RASBT';
    const currentRepo = 'Llms-From-Scratch';
    const currentEdition = '';

    // 判定是否有【其他】教程需要展示：
    const hasOtherGlobalDockTutorials = dockTutorials.some((t) => {
      if (!currentOwner || !currentRepo) return true;
      if (t.owner !== currentOwner || t.repo !== currentRepo) return true;
      const tutEdition = t.edition || '';
      return tutEdition !== currentEdition;
    });

    // 此时全局 dock 仅有当前教程，全局胶囊在此页面隐身；单仓胶囊绝不应盲目让位
    expect(hasOtherGlobalDockTutorials).toBe(false);

    // 当有其他仓库的教程进入 dock 时：
    store.addOrUpdateTutorial({
      id: 'karpathy/minGPT',
      owner: 'karpathy',
      repo: 'minGPT',
      edition: null,
      title: 'minGPT',
      url: '/docs/karpathy/minGPT',
      status: 'PROCESSING',
      startedAt: Date.now(),
      activeChapterTitle: '第 1 章：minGPT',
      completedChapters: 0,
      totalChapters: 5,
      updatedAt: Date.now(),
    });

    const updatedDock = useTutorialDockStore.getState().tutorials;
    const hasOtherWithMultiple = updatedDock.some((t) => {
      if (!currentOwner || !currentRepo) return true;
      if (t.owner !== currentOwner || t.repo !== currentRepo) return true;
      const tutEdition = t.edition || '';
      return tutEdition !== currentEdition;
    });

    // 此时存在非本仓的全局教程，单仓胶囊正确让位给全局胶囊
    expect(hasOtherWithMultiple).toBe(true);
  });
});

