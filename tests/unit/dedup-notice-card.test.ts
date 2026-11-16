import { describe, expect, it, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { DedupNoticeCard } from '@/components/ImportWizard/scout/DedupNoticeCard';
import { setLocale } from '@/paraglide/runtime.js';
import type { WizardDedupInfo } from '@/lib/stores/import-wizard-store';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'test-user-id' } } }),
}));

const mockActiveModel = vi.fn().mockReturnValue({ activeModel: 'deepseek-chat' });
vi.mock('@/components/ImportWizard/common/WizardModelSelector', () => ({
  useActiveWizardModel: () => mockActiveModel(),
  WizardModelBadge: () => React.createElement('div', null, 'badge'),
}));

vi.mock('@/lib/stores/import-wizard-store', () => {
  const store = {
    scoutData: null,
    parsedUrlInfo: { owner: 'facebook', repo: 'react' },
    url: 'https://github.com/facebook/react',
  };
  return {
    useImportWizardStore: (selector: (s: typeof store) => unknown) => selector(store),
    wizardSetters: {
      setCreateEdition: vi.fn(),
      setEditionLabel: vi.fn(),
    },
  };
});

describe('DedupNoticeCard (导入查重与场景三元决策卡片)', () => {
  beforeEach(() => {
    setLocale('zh-CN');
    mockActiveModel.mockReturnValue({ activeModel: 'deepseek-chat' });
  });

  const baseDedupInfo: WizardDedupInfo = {
    existsOnShelf: false,
    existsInExplore: true,
    existingRepo: {
      id: 'repo-fb-react',
      owner: 'facebook',
      repo: 'react',
      gitSha: 'sha123',
      transcriptionModels: ['qwen-plus'],
      isPublic: true,
      isMaintainer: false,
    },
    isFork: false,
    upstream: null,
    upstreamExistsInExplore: false,
    upstreamRepo: null,
  };

  it('场景 A（他人公开教程，访客/非维护者）：严禁展示任何覆盖按钮，仅展示专属对比版本创建行动', () => {
    const dedupInfo: WizardDedupInfo = {
      ...baseDedupInfo,
      existsInExplore: true,
      existingRepo: {
        ...baseDedupInfo.existingRepo!,
        isPublic: true,
        isMaintainer: false,
      },
    };

    const html = renderToString(
      React.createElement(DedupNoticeCard, {
        dedupInfo,
        sameSource: null,
        sameSourceVisible: false,
        setHasDismissedDedup: () => {},
        resetWizard: () => {},
        handleScout: async () => {},
      })
    );

    // 标题与说明
    expect(html).toContain('广场已有公开教程');
    expect(html).toContain('可以创建新版本');
    // 单一行动按钮
    expect(html).toContain('创建我的版本');
    // 严禁出现任何形式的覆盖文案与按钮
    expect(html).not.toContain('更新主教程');
    expect(html).not.toContain('重新覆盖教程');
    expect(html).not.toContain('仍重新解析');
    // 包含直达公共教程的链接
    expect(html).toContain('查阅现有教程');
    // 多主题保证：不能包含 text-white 导致暗黑主题隐形，必须使用 text-theme-primary-fg
    expect(html).not.toContain('text-white');
    expect(html).toContain('text-theme-primary-fg');
  });

  it('场景 B（公开主教程，原作者/维护者）：仅展示创建新版本，严禁展示更新主教程', () => {
    const dedupInfo: WizardDedupInfo = {
      ...baseDedupInfo,
      existsInExplore: true,
      existingRepo: {
        ...baseDedupInfo.existingRepo!,
        isPublic: true,
        isMaintainer: true,
      },
    };

    const html = renderToString(
      React.createElement(DedupNoticeCard, {
        dedupInfo,
        sameSource: null,
        sameSourceVisible: false,
        setHasDismissedDedup: () => {},
        resetWizard: () => {},
        handleScout: async () => {},
      })
    );

    expect(html).toContain('你的公开教程');
    expect(html).toContain('满意后再设为主版本');
    expect(html).toContain('创建新版本');
    expect(html).not.toContain('更新主教程');
    expect(html).toContain('查阅现有教程');
    expect(html).not.toContain('text-white');
    expect(html).toContain('text-theme-primary-fg');
  });

  it('场景 C（私有书架教程）：仅展示创建新版本，严禁展示重新覆盖教程', () => {
    const dedupInfo: WizardDedupInfo = {
      ...baseDedupInfo,
      existsOnShelf: true,
      existsInExplore: false,
      existingRepo: {
        ...baseDedupInfo.existingRepo!,
        isPublic: false,
        isMaintainer: true,
      },
    };

    const html = renderToString(
      React.createElement(DedupNoticeCard, {
        dedupInfo,
        sameSource: null,
        sameSourceVisible: false,
        setHasDismissedDedup: () => {},
        resetWizard: () => {},
        handleScout: async () => {},
      })
    );

    expect(html).toContain('书架已有教程');
    expect(html).toContain('检测到个人书架已有该项目');
    expect(html).toContain('创建新版本');
    expect(html).not.toContain('重新覆盖教程');
    expect(html).toContain('查阅书架教程');
    expect(html).not.toContain('text-white');
    expect(html).toContain('text-theme-primary-fg');
  });

  it('顶部已有教程胶囊：仅显示已有教程所属模型，不过早展示本次过渡', () => {
    mockActiveModel.mockReturnValue({ activeModel: 'deepseek-v4.1-flash' });
    const dedupInfo: WizardDedupInfo = {
      ...baseDedupInfo,
      existingRepo: {
        ...baseDedupInfo.existingRepo!,
        transcriptionModels: ['qwen3.8-flash'],
      },
    };

    const html = renderToString(
      React.createElement(DedupNoticeCard, {
        dedupInfo,
        sameSource: null,
        sameSourceVisible: false,
        setHasDismissedDedup: () => {},
        resetWizard: () => {},
        handleScout: async () => {},
      })
    );

    expect(html).toContain('facebook/react');
    expect(html).toContain('qwen3.8-flash');
    expect(html).not.toContain('➔');
    expect(html).not.toContain('本次:');
  });

  it('未选择模型时回退到安全默认文案且无未定义占位', () => {
    mockActiveModel.mockReturnValue({ activeModel: '' });
    const dedupInfo: WizardDedupInfo = {
      ...baseDedupInfo,
      existingRepo: {
        ...baseDedupInfo.existingRepo!,
        transcriptionModels: [],
        isMaintainer: false,
      },
    };

    const html = renderToString(
      React.createElement(DedupNoticeCard, {
        dedupInfo,
        sameSource: null,
        sameSourceVisible: false,
        setHasDismissedDedup: () => {},
        resetWizard: () => {},
        handleScout: async () => {},
      })
    );

    expect(html).toContain('创建我的版本');
    expect(html).not.toContain('undefined');
  });
});
