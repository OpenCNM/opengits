import { describe, expect, it, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { DashboardFeedCard } from '@/components/home/components/dashboard/DashboardFeedCard';
import { DisplayRepo } from '@/lib/home-data';
import { setLocale } from '@/paraglide/runtime.js';

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: any) => React.createElement('div', null, children),
  Tooltip: ({ children }: any) => React.createElement('div', null, children),
  TooltipTrigger: ({ children, className }: any) => React.createElement('div', { className }, children),
  TooltipPopup: ({ children }: any) => React.createElement('div', null, children),
}));

vi.mock('@/components/update/RelayAvatarStack', () => ({
  RelayAvatarStack: () => React.createElement('div', { 'data-testid': 'relay-avatar-stack' }, 'avatars'),
}));

describe('DashboardFeedCard (公共教程卡片标签精简验证)', () => {
  beforeEach(() => {
    setLocale('zh-CN');
  });

  const mockGithubRepo: DisplayRepo = {
    id: 'repo-1',
    owner: 'xtls',
    repo: 'xray-core',
    title: 'Xray Core Project',
    isPublic: true,
    isSaved: false,
    savedCount: 12,
    progress: 50,
    chapterCount: 8,
    processedDocsCount: 8,
    isFullyTranscribed: true,
    viewedCount: 39,
    hasUpdate: false,
    importedSha: 'd562d89',
    isPinned: false,
    shelfFeeEstimate: 0,
  };

  const mockWebDocRepo: DisplayRepo = {
    id: 'repo-2',
    owner: 'web-doc',
    repo: 'rust-async-book',
    title: 'Asynchronous Programming in Rust',
    category: 'Rust',
    isPublic: true,
    isSaved: true,
    savedCount: 88,
    progress: 80,
    chapterCount: 15,
    processedDocsCount: 15,
    isFullyTranscribed: true,
    viewedCount: 520,
    hasUpdate: false,
    importedSha: 'fa129cd',
    isPinned: false,
    shelfFeeEstimate: 10,
    repoProfile: {
      sourceType: 'web',
      originalUrl: 'https://rust-lang.github.io/async-book/',
      siteTitle: 'rust-async-book',
    },
  };

  it('GitHub 仓库卡片中不应渲染「GitHub 仓库」tag 胶囊', () => {
    const html = renderToString(
      React.createElement(DashboardFeedCard, {
        repo: mockGithubRepo,
        onToggleSave: () => {},
        onOpenEditionDrawer: () => {},
        onOpenRelayWorkbench: () => {},
        onEditionSavedChange: () => {},
        onCreateEdition: () => {},
        onOpenDetail: () => {},
      })
    );

    // 必须包含仓库基础信息
    expect(html).toContain('xtls');
    expect(html).toContain('xray-core');

    // 严禁包含「GitHub 仓库」tag（仅保留左侧小图标 Tooltip 内的语义）
    expect(html).not.toContain('px-1.5 py-0.5 rounded bg-theme-surface text-micro font-sans font-medium text-theme-muted shrink-0 border border-theme-border/60');
  });

  it('官方文档 WebDoc 卡片中不应渲染「官方文档」tag 胶囊', () => {
    const html = renderToString(
      React.createElement(DashboardFeedCard, {
        repo: mockWebDocRepo,
        onToggleSave: () => {},
        onOpenEditionDrawer: () => {},
        onOpenRelayWorkbench: () => {},
        onEditionSavedChange: () => {},
        onCreateEdition: () => {},
        onOpenDetail: () => {},
      })
    );

    // 必须包含文档标题与真实来源路径（替换原硬编码 'doc'）
    expect(html).toContain('rust-async-book');
    expect(html).toContain('rust-lang.github.io/async-book');

    // 严禁包含「官方文档」tag 胶囊
    expect(html).not.toContain('px-1.5 py-0.5 rounded bg-theme-primary/10 text-theme-primary text-micro font-sans font-medium shrink-0 border border-theme-primary/20');

    // 官方文档必须透出「文档快照」与哈希「fa129cd」，严禁透出「ref: main」
    expect(html).toContain('文档快照');
    expect(html).toContain('fa129cd');
    expect(html).not.toContain('ref: main');
  });

  it('WebDoc 存量标题为 Introduction/Getting Started 等通用词时自动回落为 URL host', () => {
    const genericTitleWebDoc: DisplayRepo = {
      ...mockWebDocRepo,
      repo: 'coss-com',
      title: 'Introduction',
      repoProfile: {
        sourceType: 'web',
        originalUrl: 'https://coss.com/ui/docs',
        siteTitle: 'Introduction',
      },
    };
    const html = renderToString(
      React.createElement(DashboardFeedCard, {
        repo: genericTitleWebDoc,
        onOpenDetail: () => {},
      })
    );

    expect(html).toContain('coss.com');
    expect(html).toContain('coss.com/ui/docs');
    expect(html).not.toContain('>Introduction<');
  });

  it('已保存卡片正常渲染已加入状态徽章', () => {
    const html = renderToString(
      React.createElement(DashboardFeedCard, {
        repo: mockWebDocRepo,
        onOpenRelayWorkbench: () => {},
        onEditionSavedChange: () => {},
        onCreateEdition: () => {},
        onOpenDetail: () => {},
      })
    );

    expect(html).toContain('已加入');
    expect(html).toContain('bg-emerald-500/10');
  });

  it('未保存卡片正常渲染所需积分或免费徽章', () => {
    // 1. 需积分仓库
    const feeRepo: DisplayRepo = {
      ...mockGithubRepo,
      isSaved: false,
      shelfFeeEstimate: 42,
    };
    const htmlWithFee = renderToString(
      React.createElement(DashboardFeedCard, {
        repo: feeRepo,
        onOpenDetail: () => {},
      })
    );
    expect(htmlWithFee).toContain('42 积分');
    expect(htmlWithFee).not.toContain('已加入');

    // 2. 免费仓库
    const freeRepo: DisplayRepo = {
      ...mockGithubRepo,
      isSaved: false,
      shelfFeeEstimate: 0,
    };
    const htmlFree = renderToString(
      React.createElement(DashboardFeedCard, {
        repo: freeRepo,
        onOpenDetail: () => {},
      })
    );
    expect(htmlFree).toContain('免费');
    expect(htmlFree).not.toContain('已加入');
  });

  it('阅读进度为 0 时不渲染进度文案（避免误以为教程生成失败并最大化精简卡片底部）', () => {
    const zeroProgressRepo: DisplayRepo = {
      ...mockGithubRepo,
      progress: 0,
    };

    const html = renderToString(
      React.createElement(DashboardFeedCard, {
        repo: zeroProgressRepo,
        onToggleSave: () => {},
        onOpenEditionDrawer: () => {},
        onOpenRelayWorkbench: () => {},
        onEditionSavedChange: () => {},
        onCreateEdition: () => {},
        onOpenDetail: () => {},
      })
    );

    // 严禁渲染孤立的 0% 或已读文案
    expect(html).not.toContain('0%');
    expect(html).not.toContain('已读');
  });

  it('阅读进度大于 0 时渲染「已读 X%」文案与进度提示', () => {
    const readProgressRepo: DisplayRepo = {
      ...mockGithubRepo,
      progress: 42,
    };

    const html = renderToString(
      React.createElement(DashboardFeedCard, {
        repo: readProgressRepo,
        onToggleSave: () => {},
        onOpenEditionDrawer: () => {},
        onOpenRelayWorkbench: () => {},
        onEditionSavedChange: () => {},
        onCreateEdition: () => {},
        onOpenDetail: () => {},
      })
    );

    expect(html).toContain('已读 42%');
    expect(html).toContain('阅读进度: 42%');
  });

  it('接力进行中时头像堆位于参与接力按钮左侧容器中', () => {
    const relayRepo: DisplayRepo = {
      ...mockGithubRepo,
      relay: {
        done: 7,
        total: 32,
        inProgress: 1,
        participants: [
          { userId: 'u1', name: 'Charlie', image: null, active: true },
          { userId: 'u2', name: 'David', image: null, active: false },
        ],
      },
    };

    const html = renderToString(
      React.createElement(DashboardFeedCard, {
        repo: relayRepo,
        onToggleSave: () => {},
        onOpenEditionDrawer: () => {},
        onOpenRelayWorkbench: () => {},
        onEditionSavedChange: () => {},
        onCreateEdition: () => {},
        onOpenDetail: () => {},
      })
    );

    // 必须包含接力进度与状态
    expect(html).toContain('7/32');
    expect(html).toContain('1 章进行中');
    expect(html).toContain('参与接力');

    // 验证头像堆在参与接力同一父容器中渲染
    expect(html).toContain('data-testid="relay-avatar-stack"');
    const avatarIndex = html.indexOf('data-testid="relay-avatar-stack"');
    const joinButtonIndex = html.indexOf('参与接力');
    expect(avatarIndex).toBeGreaterThan(-1);
    expect(joinButtonIndex).toBeGreaterThan(avatarIndex);
  });

  it('多版本跨分支时自适应透出「多分支 (main, dev)」与章节跨度范围', () => {
    const multiBranchEditions = [
      {
        id: 'ed-1',
        title: '标准教程',
        isDefault: true,
        branch: 'main',
        gitSha: 'a5b59a9123',
        chapterCount: 6,
        model: 'qwen3.8-flash',
      },
      {
        id: 'ed-2',
        title: '开发版',
        isDefault: false,
        branch: 'dev',
        gitSha: 'a14b3de456',
        chapterCount: 8,
        model: 'qwen3.8-max',
      },
    ];

    const html = renderToString(
      React.createElement(DashboardFeedCard, {
        repo: {
          ...mockGithubRepo,
          branch: 'main',
          gitSha: 'a5b59a9123',
          chapterCount: 6,
        },
        editions: multiBranchEditions,
        onToggleSave: () => {},
        onOpenEditionDrawer: () => {},
        onOpenRelayWorkbench: () => {},
        onEditionSavedChange: () => {},
        onCreateEdition: () => {},
        onOpenDetail: () => {},
      })
    );

    // 章节跨度显示 6-8 章节
    expect(html).toContain('6-8 章节');
    // 分支自适应显示「多分支 (main, dev)」
    expect(html).toContain('多分支 (main, dev)');
    // Tooltip 内映射标题
    expect(html).toContain('各版本对应分支与提交');
  });

  it('单分支多版本时正常保持单个分支 SHA 与固定章节数', () => {
    const singleBranchEditions = [
      {
        id: 'ed-1',
        title: '标准版',
        isDefault: true,
        branch: 'main',
        gitSha: 'a5b59a9123',
        chapterCount: 6,
        model: 'qwen3.8-flash',
      },
      {
        id: 'ed-2',
        title: '深度解析版',
        isDefault: false,
        branch: 'main',
        gitSha: 'a5b59a9123',
        chapterCount: 6,
        model: 'qwen3.8-max',
      },
    ];

    const html = renderToString(
      React.createElement(DashboardFeedCard, {
        repo: {
          ...mockGithubRepo,
          branch: 'main',
          gitSha: 'a5b59a9123',
          chapterCount: 6,
        },
        editions: singleBranchEditions,
        onToggleSave: () => {},
        onOpenEditionDrawer: () => {},
        onOpenRelayWorkbench: () => {},
        onEditionSavedChange: () => {},
        onCreateEdition: () => {},
        onOpenDetail: () => {},
      })
    );

    // 固定章节显示
    expect(html).toContain('6 章节');
    // 单分支显示
    expect(html).toContain('ref: ');
    expect(html).toContain('main');
    expect(html).toContain('a5b59a9');
    expect(html).not.toContain('多分支');
  });

  it('卡片标题后不渲染领域分类角标，无论 GitHub 仓库还是 WebDoc 均保持标题与简介最高信噪比', () => {
    const cloudGithubRepo: DisplayRepo = {
      ...mockGithubRepo,
      category: 'Cloud',
    };
    const htmlGithub = renderToString(
      React.createElement(DashboardFeedCard, {
        repo: cloudGithubRepo,
        onOpenDetail: () => {},
      })
    );
    expect(htmlGithub).not.toContain('后端与云原生');
    expect(htmlGithub).not.toContain('云原生');

    const aiDocRepo: DisplayRepo = {
      ...mockWebDocRepo,
      category: 'AI',
    };
    const htmlDoc = renderToString(
      React.createElement(DashboardFeedCard, {
        repo: aiDocRepo,
        onOpenDetail: () => {},
      })
    );
    expect(htmlDoc).not.toContain('AI & 大模型');
  });

  it('卡片主体精简化：不应在封面渲染冗余的 tags 药丸，保持一句话简介高密度纯粹', () => {
    const taggedRepo: DisplayRepo = {
      ...mockGithubRepo,
      tags: ['CUDA', 'PyTorch'],
    };
    const html = renderToString(
      React.createElement(DashboardFeedCard, {
        repo: taggedRepo,
        onOpenDetail: () => {},
      })
    );
    expect(html).not.toContain('#CUDA');
    expect(html).not.toContain('#PyTorch');
  });

  it('当仓库包含简介时正常渲染一句话介绍，并在底部元数据区保留章节规模', () => {
    const descRepo: DisplayRepo = {
      ...mockWebDocRepo,
      description: 'AMD 开源 GPU 软件栈与异构计算开发套件指南',
      chapterCount: 32,
    };
    const html = renderToString(
      React.createElement(DashboardFeedCard, {
        repo: descRepo,
        onOpenDetail: () => {},
      })
    );
    expect(html).toContain('AMD 开源 GPU 软件栈与异构计算开发套件指南');
    expect(html).toContain('32 章节');
    // 方案 A 统一排版：包含简介的卡片同样保持来源路径与快照标识
    expect(html).toContain('rust-lang.github.io/async-book');
    expect(html).toContain('文档快照');
  });

  it('WebDoc 优先展示 repoProfile.siteTitle 人类可读标题', () => {
    const webRepoWithSiteTitle: DisplayRepo = {
      ...mockWebDocRepo,
      repoProfile: {
        sourceType: 'web',
        siteTitle: 'Rust 异步编程指南 (Async Book)',
      },
    };
    const html = renderToString(
      React.createElement(DashboardFeedCard, {
        repo: webRepoWithSiteTitle,
        onOpenDetail: () => {},
      })
    );
    expect(html).toContain('Rust 异步编程指南 (Async Book)');
  });

  it('卡片底部元数据栏清晰展示「更新于 xxx」文案而非孤立的时间字符', () => {
    const updatedRepo: DisplayRepo = {
      ...mockGithubRepo,
      updatedAt: new Date(Date.now() - 7 * 60 * 1000), // 7 分钟前
    };
    const html = renderToString(
      React.createElement(DashboardFeedCard, {
        repo: updatedRepo,
        onOpenDetail: () => {},
      })
    );
    expect(html).toContain('更新于 7分钟前');
  });
});
