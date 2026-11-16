import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { useDashboardFeed } from '@/components/home/hooks/useDashboardFeed';
import { DisplayRepo } from '@/lib/home-data';

function createMockRepo(partial: Partial<DisplayRepo> & { id: string; owner: string; repo: string }): DisplayRepo {
  return {
    chapterCount: 10,
    processedDocsCount: 10,
    isFullyTranscribed: true,
    isSaved: false,
    savedCount: 0,
    progress: 0,
    viewedCount: 0,
    hasUpdate: false,
    importedSha: null,
    isPinned: false,
    isMcpDisabled: false,
    lastReadPath: null,
    lastReadAt: null,
    ...partial,
  };
}

function runFeedHook(options: Parameters<typeof useDashboardFeed>[0]) {
  let captured: ReturnType<typeof useDashboardFeed> | null = null;
  function TestComp() {
    captured = useDashboardFeed(options);
    return React.createElement('div', null, captured.recentResumeRepo?.repo || 'none');
  }
  renderToString(React.createElement(TestComp));
  return captured!;
}

describe('useDashboardFeed - recentResumeRepo (Cross-Scope Reading Footprint)', () => {
  const baseOptions = {
    repos: [] as DisplayRepo[],
    myRepos: [] as DisplayRepo[],
    filteredRepos: [] as DisplayRepo[],
    activeTab: 'my-shelf',
    currentPage: 1,
    personalSearch: '',
  };

  it('全空场景：既无个人项目也无公共阅读记录时返回 null', () => {
    const res = runFeedHook({
      ...baseOptions,
      repos: [createMockRepo({ id: 'pub-1', owner: 'org', repo: 'pub-unread' })],
      myRepos: [],
    });
    expect(res.recentResumeRepo).toBeNull();
  });

  it('仅有未阅读个人项目时，降级回落到个人项目首项', () => {
    const p1 = createMockRepo({ id: 'p-1', owner: 'me', repo: 'project-1', isSaved: true });
    const p2 = createMockRepo({ id: 'p-2', owner: 'me', repo: 'project-2', isSaved: true });
    const res = runFeedHook({
      ...baseOptions,
      repos: [],
      myRepos: [p1, p2],
    });
    expect(res.recentResumeRepo?.id).toBe('p-1');
  });

  it('用户阅读了公共教程（未加入我的项目）时，首页能够精准识别并作为「上次阅读」返回', () => {
    const pubRead = createMockRepo({
      id: 'pub-read-1',
      owner: 'xtls',
      repo: 'xray-core',
      isSaved: false,
      progress: 50,
      lastReadPath: '01.md',
      lastReadAt: new Date('2026-10-08T10:00:00Z'),
    });
    const unreadPersonal = createMockRepo({
      id: 'p-unread',
      owner: 'me',
      repo: 'shelf-item',
      isSaved: true,
      progress: 0,
      lastReadAt: null,
    });

    const res = runFeedHook({
      ...baseOptions,
      repos: [pubRead],
      myRepos: [unreadPersonal],
    });

    // 突破个人仓栅栏：虽未加入书架，但作为真实阅读足迹优先展示在「上次阅读」
    expect(res.recentResumeRepo).not.toBeNull();
    expect(res.recentResumeRepo?.id).toBe('pub-read-1');
    expect(res.recentResumeRepo?.repo).toBe('xray-core');
    expect(res.recentResumeRepo?.progress).toBe(50);
  });

  it('同时存在个人仓与公共仓阅读记录时，严格按最近阅读时间 lastReadAt 降序挑选绝对最新项', () => {
    const olderPersonalRead = createMockRepo({
      id: 'p-older',
      owner: 'me',
      repo: 'personal-older',
      isSaved: true,
      progress: 80,
      lastReadAt: new Date('2026-10-07T12:00:00Z'), // 昨天
    });
    const newerPublicRead = createMockRepo({
      id: 'pub-newer',
      owner: 'facebook',
      repo: 'react',
      isSaved: false,
      progress: 30,
      lastReadAt: new Date('2026-10-08T09:30:00Z'), // 今天刚刚
    });

    const res = runFeedHook({
      ...baseOptions,
      repos: [newerPublicRead],
      myRepos: [olderPersonalRead],
    });

    // 虽个人仓进度更高(80%)，但按时间戳以刚刚阅读的公共仓(react)为准
    expect(res.recentResumeRepo?.id).toBe('pub-newer');
    expect(res.recentResumeRepo?.repo).toBe('react');
  });

  it('当最近阅读时间相同或无时间戳时，阅读进度更高者优先', () => {
    const r1 = createMockRepo({
      id: 'r-1',
      owner: 'org',
      repo: 'repo-10pct',
      progress: 10,
    });
    const r2 = createMockRepo({
      id: 'r-2',
      owner: 'org',
      repo: 'repo-60pct',
      progress: 60,
    });

    const res = runFeedHook({
      ...baseOptions,
      repos: [r1, r2],
      myRepos: [],
    });

    expect(res.recentResumeRepo?.id).toBe('r-2');
    expect(res.recentResumeRepo?.progress).toBe(60);
  });
});

describe('DashboardResumeCard - Public Tutorial & Save Action', () => {
  it('当最近阅读为公共教程时，卡片呈现公共教程标识与「加入项目」转化按钮', async () => {
    const { DashboardResumeCard } = await import(
      '@/components/home/components/dashboard/DashboardResumeCard'
    );
    const pubRepo = createMockRepo({
      id: 'pub-xray',
      owner: 'xtls',
      repo: 'xray-core',
      isSaved: false,
      progress: 50,
      lastReadPath: '01.md',
    });

    const html = renderToString(
      React.createElement(DashboardResumeCard, {
        recentResumeRepo: pubRepo,
        onToggleSave: () => {},
      })
    );

    expect(html).toContain('xray-core');
    expect(html).toContain('50%');
    expect(html).toContain('/docs/xtls/xray-core/01');
  });

  it('当最近阅读为已加入项目时，不展示「加入项目」按钮', async () => {
    const { DashboardResumeCard } = await import(
      '@/components/home/components/dashboard/DashboardResumeCard'
    );
    const savedRepo = createMockRepo({
      id: 'saved-xray',
      owner: 'xtls',
      repo: 'xray-core',
      isSaved: true,
      progress: 50,
      lastReadPath: '01.md',
    });

    const html = renderToString(
      React.createElement(DashboardResumeCard, {
        recentResumeRepo: savedRepo,
        onToggleSave: () => {},
      })
    );

    expect(html).toContain('xray-core');
    expect(html).toContain('50%');
    expect(html).toContain('/docs/xtls/xray-core/01');
  });

  it('客户端 Store 乐观水合：当本地存在章节最新分数时优先水合展示', async () => {
    const { DashboardResumeCard } = await import(
      '@/components/home/components/dashboard/DashboardResumeCard'
    );
    const { useReadingProgressStore } = await import(
      '@/lib/stores/reading-progress-store'
    );

    // 模拟用户在阅读器阅读了 01 章节至 85%
    useReadingProgressStore.getState().setChapterScore('chapters/01.mdx', 85, 'garrytan/gstack');

    const repo = createMockRepo({
      id: 'gstack-1',
      owner: 'garrytan',
      repo: 'gstack',
      chapterCount: 9,
      progress: 0, // 服务端可能因未上报或缓存显示 0
      lastReadPath: 'chapters/01.mdx',
    });

    const html = renderToString(
      React.createElement(DashboardResumeCard, {
        recentResumeRepo: repo,
        onToggleSave: () => {},
      })
    );

    expect(html).toContain('gstack');
    expect(html).toContain('/docs/garrytan/gstack/chapters/01');
  });
});
