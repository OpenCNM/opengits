import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { DashboardSourceFilterPills } from '@/components/home/components/dashboard/DashboardSourceFilterPills';
import { DashboardSidebarRepoList } from '@/components/home/components/dashboard/DashboardSidebarRepoList';
import { useDashboardFeed } from '@/components/home/hooks/useDashboardFeed';
import type { DashboardSourceType } from '@/lib/search/smart-repo-search';
import type { DisplayRepo, EditionChip } from '@/lib/home-data';
import { setLocale } from '@/paraglide/runtime.js';

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
  Tooltip: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
  TooltipTrigger: ({
    children,
    className,
  }: React.PropsWithChildren<{ className?: string }>) =>
    React.createElement('div', { className }, children),
  TooltipPopup: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
}));

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({
    children,
    className,
  }: React.PropsWithChildren<{ className?: string }>) =>
    React.createElement('div', { className }, children),
}));

const EMPTY_EDITIONS = (): EditionChip[] => [];

function createMockRepo(overrides: Partial<DisplayRepo> & Pick<DisplayRepo, 'id' | 'owner' | 'repo'>): DisplayRepo {
  return {
    title: overrides.repo,
    isPublic: true,
    isSaved: true,
    savedCount: 1,
    progress: 0,
    chapterCount: 5,
    processedDocsCount: 5,
    isFullyTranscribed: true,
    viewedCount: 10,
    hasUpdate: false,
    importedSha: 'abc1234',
    isPinned: false,
    isMcpDisabled: false,
    lastReadPath: null,
    ...overrides,
  };
}

interface FeedHookSnapshot {
  personalRepoIds: string[];
  personalSourceCounts: { all: number; github: number; webdoc: number };
  recentResumeRepoId: string | null;
}

interface FeedHarnessProps {
  repos: DisplayRepo[];
  myRepos: DisplayRepo[];
  personalSearch?: string;
  personalSourceType?: DashboardSourceType;
  onCapture: (snapshot: FeedHookSnapshot) => void;
}

function FeedHarness({
  repos,
  myRepos,
  personalSearch = '',
  personalSourceType = 'all',
  onCapture,
}: FeedHarnessProps) {
  const result = useDashboardFeed({
    repos,
    myRepos,
    filteredRepos: repos,
    activeTab: 'discover',
    currentPage: 1,
    personalSearch,
    personalSourceType,
    pinnedOverrides: {},
  });

  onCapture({
    personalRepoIds: result.personalRepos.map((repo) => repo.id),
    personalSourceCounts: result.personalSourceCounts,
    recentResumeRepoId: result.recentResumeRepo?.id ?? null,
  });

  return React.createElement('div', { 'data-testid': 'feed-output' });
}

describe('Dashboard sidebar source switcher & clean row chrome', () => {
  beforeEach(() => {
    setLocale('zh-CN');
  });

  const githubRepoPrimary = createMockRepo({
    id: 'gh-1',
    owner: 'karpathy',
    repo: 'micrograd',
    title: 'micrograd',
    lastReadPath: '01-intro.md',
    lastReadAt: '2026-11-11T10:00:00Z',
  });

  const githubRepoSecondary = createMockRepo({
    id: 'gh-2',
    owner: 'vercel-labs',
    repo: 'agent-browser',
    title: 'agent-browser',
  });

  const webDocRepo = createMockRepo({
    id: 'doc-1',
    owner: 'web-doc',
    repo: 'coss-ui-docs',
    title: 'Getting Started',
    repoProfile: {
      sourceType: 'web',
      siteTitle: 'Getting Started',
      originalUrl: 'https://coss.com/ui/docs',
    },
  });

  const personalMix = [githubRepoPrimary, githubRepoSecondary, webDocRepo];

  it('compact 侧栏筛选器在 zh-CN / en 下正确渲染短标签、数量与激活态', () => {
    const zhHtml = renderToString(
      React.createElement(DashboardSourceFilterPills, {
        compact: true,
        sourceType: 'webdoc',
        onSelectSourceType: () => {},
        counts: { all: 29, github: 28, webdoc: 1 },
      }),
    );

    expect(zhHtml).toContain('全部');
    expect(zhHtml).toContain('GitHub');
    expect(zhHtml).toContain('文档');
    expect(zhHtml).toContain('>29<');
    expect(zhHtml).toContain('>28<');
    expect(zhHtml).toContain('>1<');
    expect(zhHtml).toContain('aria-pressed="true"');

    setLocale('en');
    const enHtml = renderToString(
      React.createElement(DashboardSourceFilterPills, {
        compact: true,
        sourceType: 'github',
        onSelectSourceType: () => {},
        counts: { all: 29, github: 28, webdoc: 1 },
      }),
    );

    expect(enHtml).toContain('All');
    expect(enHtml).toContain('GitHub');
    expect(enHtml).toContain('Docs');
  });

  it('侧栏列表项不再为每行渲染常驻 ArrowRight 箭头，且保留项目标题与文档显示名', () => {
    const html = renderToString(
      React.createElement(DashboardSidebarRepoList, {
        repos: personalMix,
        editionsOf: EMPTY_EDITIONS,
      }),
    );

    expect(html).toContain('karpathy/micrograd');
    expect(html).toContain('vercel-labs/agent-browser');
    // 风格 B：存量 "Getting Started" 通用标题自动回落为 coss.com
    expect(html).toContain('coss.com');
    expect(html).not.toContain('Getting Started');
    expect(html).not.toContain('lucide-arrow-right');
  });

  it('侧栏空列表根据 isFiltered 区分「未找到匹配的项目」与「书架暂空」文案', () => {
    const filteredEmptyHtml = renderToString(
      React.createElement(DashboardSidebarRepoList, {
        repos: [],
        editionsOf: EMPTY_EDITIONS,
        isFiltered: true,
      }),
    );

    expect(filteredEmptyHtml).toContain('未找到匹配的项目');
    expect(filteredEmptyHtml).not.toContain('书架暂空，前往广场挑选');

    const bookshelfEmptyHtml = renderToString(
      React.createElement(DashboardSidebarRepoList, {
        repos: [],
        editionsOf: EMPTY_EDITIONS,
        isFiltered: false,
      }),
    );

    expect(bookshelfEmptyHtml).toContain('书架暂空，前往广场挑选');
    expect(bookshelfEmptyHtml).not.toContain('未找到匹配的项目');
  });

  it('useDashboardFeed 按 GitHub / 文档独立筛选我的项目，不影响总数统计与最近阅读卡片', () => {
    const extractOutput = (props: Omit<FeedHarnessProps, 'onCapture'>) => {
      let captured: FeedHookSnapshot | null = null;
      renderToString(
        React.createElement(FeedHarness, {
          ...props,
          onCapture: (snapshot) => {
            captured = snapshot;
          },
        }),
      );
      expect(captured).not.toBeNull();
      return captured!;
    };

    const allResult = extractOutput({
      repos: personalMix,
      myRepos: personalMix,
      personalSourceType: 'all',
    });
    expect(allResult.personalRepoIds).toEqual(['gh-1', 'gh-2', 'doc-1']);
    expect(allResult.personalSourceCounts).toEqual({ all: 3, github: 2, webdoc: 1 });
    expect(allResult.recentResumeRepoId).toBe('gh-1');

    const githubOnly = extractOutput({
      repos: personalMix,
      myRepos: personalMix,
      personalSourceType: 'github',
    });
    expect(githubOnly.personalRepoIds).toEqual(['gh-1', 'gh-2']);
    expect(githubOnly.personalSourceCounts).toEqual({ all: 3, github: 2, webdoc: 1 });

    const webDocOnly = extractOutput({
      repos: personalMix,
      myRepos: personalMix,
      personalSourceType: 'webdoc',
    });
    expect(webDocOnly.personalRepoIds).toEqual(['doc-1']);
    expect(webDocOnly.personalSourceCounts).toEqual({ all: 3, github: 2, webdoc: 1 });
    // Switching the sidebar source filter must not disturb recentResumeRepo
    expect(webDocOnly.recentResumeRepoId).toBe('gh-1');

    const searchByWebDocTitle = extractOutput({
      repos: personalMix,
      myRepos: personalMix,
      personalSourceType: 'all',
      personalSearch: 'coss.com',
    });
    expect(searchByWebDocTitle.personalRepoIds).toEqual(['doc-1']);

    const searchMismatchUnderGithubFilter = extractOutput({
      repos: personalMix,
      myRepos: personalMix,
      personalSourceType: 'github',
      personalSearch: 'coss.com',
    });
    expect(searchMismatchUnderGithubFilter.personalRepoIds).toEqual([]);
  });
});
