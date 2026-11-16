import { describe, expect, it, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { TutorialDetailDialog } from '@/components/home/components/dashboard/TutorialDetailDialog';
import { DisplayRepo, EditionChip } from '@/lib/home-data';
import { setLocale } from '@/paraglide/runtime.js';

// Mock dialog primitives
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: any) => (open ? React.createElement('div', { 'data-testid': 'dialog-root' }, children) : null),
  DialogPopup: ({ children, className }: any) => React.createElement('div', { 'data-testid': 'dialog-popup', className }, children),
  DialogHeader: ({ children }: any) => React.createElement('div', { 'data-testid': 'dialog-header' }, children),
  DialogTitle: ({ children }: any) => React.createElement('div', { 'data-testid': 'dialog-title' }, children),
  DialogPanel: ({ children, className }: any) => React.createElement('div', { 'data-testid': 'dialog-panel', className }, children),
  DialogFooter: ({ children, className }: any) => React.createElement('div', { 'data-testid': 'dialog-footer', className }, children),
}));

vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: () => null,
}));

vi.mock('@/components/repo/RepoGithubOriginPopover', () => ({
  GithubIcon: () => React.createElement('span', null, 'gh'),
}));

vi.mock('@/components/update/RelayAvatarStack', () => ({
  RelayAvatarStack: () => React.createElement('div', { 'data-testid': 'avatar-stack' }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/lib/api/client', () => ({
  api: {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/lib/stores/user-credits-store', () => ({
  useUserCreditsStore: (selector: any) => selector({ data: { creditBalance: 100 }, fetchCredits: vi.fn() }),
}));

function createMockRepo(partial: Partial<DisplayRepo> & { id: string; owner: string; repo: string }): DisplayRepo {
  return {
    chapterCount: 13,
    processedDocsCount: 3,
    isFullyTranscribed: false,
    isSaved: false,
    savedCount: 3,
    progress: 0,
    viewedCount: 10,
    hasUpdate: false,
    importedSha: '4e3eb63',
    isPinned: false,
    isMcpDisabled: false,
    lastReadPath: null,
    lastReadAt: null,
    relayEnabled: true,
    relay: {
      total: 13,
      done: 3,
      inProgress: 0,
      participants: [{ userId: 'u1', name: 'User 1' }],
    },
    ...partial,
  };
}

describe('TutorialDetailDialog 多版本接力状态隔离', () => {
  beforeEach(() => {
    setLocale('zh-CN');
    vi.clearAllMocks();
  });

  const standardChip: EditionChip = {
    id: 'repo-std',
    edition: '',
    label: '标准教程',
    presetId: null,
    isDefault: true,
    isSaved: false,
    progress: 0,
    chapterCount: 13,
    processedDocsCount: 3,
    docUrl: '/docs/chidiwilliams/buzz',
    relayEnabled: true,
    isFullyTranscribed: false,
    relay: {
      total: 13,
      done: 3,
      inProgress: 0,
      participants: [{ userId: 'u1', name: 'User 1' }],
    },
  };

  const glmChip: EditionChip = {
    id: 'repo-glm',
    edition: 'ed_glm53',
    label: 'glm-5.3-flash',
    presetId: null,
    isDefault: false,
    isSaved: false,
    progress: 20,
    chapterCount: 5,
    processedDocsCount: 5,
    docUrl: '/docs/chidiwilliams/buzz?edition=ed_glm53',
    transcriptionModels: ['glm-5.3-flash'],
    relayEnabled: false,
    isFullyTranscribed: true,
    relay: null,
  };

  it('当选中完全转录完成的 glm 版本时，绝不渲染接力卡片与接力徽章', () => {
    const repo = createMockRepo({
      id: 'repo-std',
      owner: 'chidiwilliams',
      repo: 'buzz',
      edition: 'ed_glm53', // 当前激活为 glm
    });

    const html = renderToString(
      React.createElement(TutorialDetailDialog, {
        open: true,
        onOpenChange: vi.fn(),
        repo,
        editions: [standardChip, glmChip],
        activeEdition: 'ed_glm53',
      })
    );

    // 确认 glm 版本的内容被正确渲染
    expect(html).toContain('glm-5.3-flash');

    // 关键断言：glm-5.3-flash 已 100% 转录完成，绝不展示接力卡片与认领描述
    expect(html).not.toContain('认领转录，过审即上架');
    expect(html).not.toContain('全书接力');
    expect(html).not.toContain('参与接力');
    expect(html).not.toContain('接力 3/13');
  });

  it('当选中未完成转录且开启接力的标准版本时，正常渲染接力卡片与进度', () => {
    const repo = createMockRepo({
      id: 'repo-std',
      owner: 'chidiwilliams',
      repo: 'buzz',
      edition: '', // 基础版本
    });

    const html = renderToString(
      React.createElement(TutorialDetailDialog, {
        open: true,
        onOpenChange: vi.fn(),
        repo,
        editions: [standardChip, glmChip],
        activeEdition: '',
        onOpenRelayWorkbench: vi.fn(),
      })
    );

    // 关键断言：标准教程处于接力中，应展示接力标签与参与入口
    expect(html).toContain('认领转录，过审即上架');
    expect(html).toContain('接力 3/13');
    expect(html).toContain('参与接力');
  });

  it('单讲法仓库头部状态栏仅展示领域与技术标签，绝不把驱动模型作为伪标签混入', () => {
    const repo = createMockRepo({
      id: 'repo-nuclei',
      owner: 'projectdiscovery',
      repo: 'nuclei',
      category: 'Systems',
      tags: ['Security', 'Vulnerability', 'Go'],
      transcriptionModels: ['qwen3.8-flash'],
    });

    const html = renderToString(
      React.createElement(TutorialDetailDialog, {
        open: true,
        onOpenChange: vi.fn(),
        repo,
        editions: [],
      })
    );

    // 弹窗头部必须包含分类与 # 标签
    expect(html).toContain('系统底层');
    expect(html).toContain('#Security');
    expect(html).toContain('#Vulnerability');
    expect(html).toContain('#Go');

    // 头部区域 (dialog-header) 严禁包含模型胶囊（模型收敛于下方制作档案网格中展示）
    const headerMatch = html.match(/data-testid="dialog-header">([\s\S]*?)<\/div>/);
    expect(headerMatch).toBeTruthy();
    expect(headerMatch![1]).not.toContain('qwen3.8-flash');
  });

  it('多版本讲法切换时，特性画像雷达图与教研亮点严格与选中版本联动', () => {
    const chipQwen: EditionChip = {
      id: 'repo-qwen',
      edition: 'ed_qwen',
      label: 'qwen3.8-max',
      presetId: null,
      isDefault: false,
      isSaved: false,
      progress: 25,
      chapterCount: 8,
      processedDocsCount: 8,
      docUrl: '/docs/cline/cline?edition=ed_qwen',
      transcriptionModels: ['qwen3.8-max'],
      reviewLlm: {
        overallScore: 88,
        archetype: 'PRACTICAL',
        coreHighlight: '千问实战演练指南',
        targetAudience: '前端全栈开发者',
        dimensions: [
          { name: 'practicality', score: 98, comment: '代码实操丰富' },
          { name: 'depth', score: 75, comment: '深度适中' },
        ],
      },
    };

    const chipGlm: EditionChip = {
      id: 'repo-glm',
      edition: 'ed_glm',
      label: 'glm-5.3-flash',
      presetId: null,
      isDefault: true,
      isSaved: false,
      progress: 10,
      chapterCount: 10,
      processedDocsCount: 10,
      docUrl: '/docs/cline/cline?edition=ed_glm',
      transcriptionModels: ['glm-5.3-flash'],
      reviewLlm: {
        overallScore: 95,
        archetype: 'ARCHITECTURE',
        coreHighlight: '智谱全模块架构深度拆解',
        targetAudience: '资深系统架构师',
        dimensions: [
          { name: 'depth', score: 96, comment: '架构深度极高' },
          { name: 'coverage', score: 95, comment: '全模块覆盖' },
        ],
      },
    };

    const repo = createMockRepo({
      id: 'repo-glm',
      owner: 'cline',
      repo: 'cline',
      edition: 'ed_qwen', // 激活 Qwen
    });

    const htmlQwen = renderToString(
      React.createElement(TutorialDetailDialog, {
        open: true,
        onOpenChange: vi.fn(),
        repo,
        editions: [chipGlm, chipQwen],
        activeEdition: 'ed_qwen',
      })
    );

    // Qwen 版本特性画像：直击核心、千问专属亮点与 4 轴指标
    expect(htmlQwen).toContain('教程特性画像');
    expect(htmlQwen).toContain('直击核心');
    expect(htmlQwen).toContain('千问实战演练指南');
    expect(htmlQwen).toContain('前端全栈开发者');
    expect(htmlQwen).toContain('架构深度');
    expect(htmlQwen).toContain('源码剖析');
    expect(htmlQwen).toContain('深入浅出');
    expect(htmlQwen).toContain('体系全景');
    expect(htmlQwen).not.toContain('智谱全模块架构深度拆解');

    // 切换到 GLM 版本
    const htmlGlm = renderToString(
      React.createElement(TutorialDetailDialog, {
        open: true,
        onOpenChange: vi.fn(),
        repo,
        editions: [chipGlm, chipQwen],
        activeEdition: 'ed_glm',
      })
    );

    // GLM 版本特性画像：宏观架构、智谱专属亮点
    expect(htmlGlm).toContain('教程特性画像');
    expect(htmlGlm).toContain('宏观架构');
    expect(htmlGlm).toContain('智谱全模块架构深度拆解');
    expect(htmlGlm).toContain('资深系统架构师');
    expect(htmlGlm).not.toContain('千问实战演练指南');
  });

  it('转录中的版本绝不显示教程特性画像、亮点与总结，而是呈现简洁的等待界面', () => {
    // 基础版本：已完工，拥有特性画像与亮点
    const completedDefaultChip: EditionChip = {
      id: 'repo-completed',
      edition: '',
      label: 'glm-5.3-flash',
      presetId: null,
      isDefault: true,
      isSaved: false,
      progress: 25,
      chapterCount: 8,
      processedDocsCount: 8,
      docUrl: '/docs/rasbt/llms-from-scratch',
      transcriptionModels: ['glm-5.3-flash'],
      isFullyTranscribed: true,
      reviewLlm: {
        overallScore: 85,
        archetype: 'ARCHITECTURE',
        coreHighlight: '以调用关系图、模块职责表与设计决策注解逐层拆解 LLM 内部架构',
        targetAudience: '具备 PyTorch 基础、希望从零理解 LLM 内部实现机制的中高级开发者',
        dimensions: [
          { name: 'depth', score: 90, comment: '架构深度极高' },
          { name: 'codeFidelity', score: 85, comment: '源码剖析详尽' },
          { name: 'pedagogy', score: 90, comment: '深入浅出' },
          { name: 'coverage', score: 87, comment: '体系全景' },
        ],
      },
    };

    // 新版本：转录中 (2/7 章节)，尚未完工
    const transcribingChip: EditionChip = {
      id: 'repo-transcribing',
      edition: 'ed_in_progress',
      label: 'glm-5.3-flash',
      presetId: null,
      isDefault: false,
      isSaved: false,
      progress: 0,
      chapterCount: 7,
      processedDocsCount: 2,
      docUrl: '/docs/rasbt/llms-from-scratch?edition=ed_in_progress',
      transcriptionModels: ['glm-5.3-flash'],
      isFullyTranscribed: false,
    };

    const repo = createMockRepo({
      id: 'repo-completed',
      owner: 'rasbt',
      repo: 'llms-from-scratch',
      chapterCount: 8,
      processedDocsCount: 8,
      isFullyTranscribed: true,
      reviewLlm: completedDefaultChip.reviewLlm,
    });

    // 1. 当激活已完工版本时：正常展示教程特性画像、亮点与适读总结
    const htmlCompleted = renderToString(
      React.createElement(TutorialDetailDialog, {
        open: true,
        onOpenChange: vi.fn(),
        repo,
        editions: [completedDefaultChip, transcribingChip],
        activeEdition: '',
      })
    );

    expect(htmlCompleted).toContain('教程特性画像');
    expect(htmlCompleted).toContain('宏观架构');
    expect(htmlCompleted).toContain('以调用关系图、模块职责表与设计决策注解逐层拆解 LLM 内部架构');
    expect(htmlCompleted).toContain('具备 PyTorch 基础');
    expect(htmlCompleted).not.toContain('AI 教程转录中…');

    // 2. 当选中转录中的版本时：绝不展示画像、亮点与总结，展示简洁的等待界面与转录进度
    const htmlTranscribing = renderToString(
      React.createElement(TutorialDetailDialog, {
        open: true,
        onOpenChange: vi.fn(),
        repo,
        editions: [completedDefaultChip, transcribingChip],
        activeEdition: 'ed_in_progress',
      })
    );

    // 核心红线校验：绝不展示特性画像、雷达指标、亮点与适读总结
    expect(htmlTranscribing).not.toContain('教程特性画像');
    expect(htmlTranscribing).not.toContain('以调用关系图、模块职责表与设计决策注解逐层拆解 LLM 内部架构');
    expect(htmlTranscribing).not.toContain('具备 PyTorch 基础、希望从零理解 LLM 内部实现机制的中高级开发者');

    // 等待界面要素校验：转录中标题、进度、百分比与说明文案
    expect(htmlTranscribing).toContain('AI 教程转录中…');
    expect(htmlTranscribing).toContain('已转录 2/7');
    expect(htmlTranscribing).toContain('29%');
    // 3. 当单版本仓库处于转录中状态时：同样绝不展示画像与亮点，展示等待界面
    const transcribingSingleRepo = createMockRepo({
      id: 'repo-single-transcribing',
      owner: 'rasbt',
      repo: 'llms-from-scratch',
      chapterCount: 7,
      processedDocsCount: 2,
      isFullyTranscribed: false,
    });

    const htmlSingleTranscribing = renderToString(
      React.createElement(TutorialDetailDialog, {
        open: true,
        onOpenChange: vi.fn(),
        repo: transcribingSingleRepo,
        editions: [],
      })
    );

    expect(htmlSingleTranscribing).not.toContain('教程特性画像');
    expect(htmlSingleTranscribing).toContain('AI 教程转录中…');
    expect(htmlSingleTranscribing).toContain('已转录 2/7');
    expect(htmlSingleTranscribing).toContain('29%');

    // 4. 当版本已全量转录完成但尚未进行 LLM 审评（reviewLlm 为空）时：
    // 呈现轮廓骨架与「系统正在评分，请稍后」，绝不展示虚假的「全能综合」流派标签与真实亮点
    const unreviewedCompletedChip: EditionChip = {
      id: 'repo-unreviewed-completed',
      edition: 'ed_unreviewed',
      label: 'glm-5.3-flash',
      presetId: null,
      isDefault: false,
      isSaved: false,
      progress: 0,
      chapterCount: 7,
      processedDocsCount: 7,
      isFullyTranscribed: true,
      docUrl: '/docs/rasbt/llms-from-scratch?edition=ed_unreviewed',
      transcriptionModels: ['glm-5.3-flash'],
      reviewPipeline: { total: 85 } as any,
      reviewLlm: null, // 尚未审评
    };

    const htmlUnreviewed = renderToString(
      React.createElement(TutorialDetailDialog, {
        open: true,
        onOpenChange: vi.fn(),
        repo,
        editions: [completedDefaultChip, unreviewedCompletedChip],
        activeEdition: 'ed_unreviewed',
      })
    );

    expect(htmlUnreviewed).not.toContain('AI 教程转录中…');
    expect(htmlUnreviewed).toContain('教程特性画像');
    expect(htmlUnreviewed).toContain('系统正在评分，请稍后');
    expect(htmlUnreviewed).not.toContain('全能综合');
  });

  it('web-docs 网页文档快照弹窗绝不渲染「转录新版本」按钮，GitHub 仓库正常渲染', () => {
    const webDocRepo = createMockRepo({
      id: 'repo-webdoc',
      owner: 'web-docs',
      repo: 'vite-dev',
      repoProfile: { repoType: 'web-docs', originalUrl: 'https://vite.dev' },
    });
    const githubRepo = createMockRepo({
      id: 'repo-gh',
      owner: 'vitejs',
      repo: 'vite',
    });

    const htmlWebDoc = renderToString(
      React.createElement(TutorialDetailDialog, {
        open: true,
        onOpenChange: vi.fn(),
        repo: webDocRepo,
        onCreateEdition: vi.fn(),
      })
    );
    expect(htmlWebDoc).not.toContain('转录新版本');

    const htmlGithub = renderToString(
      React.createElement(TutorialDetailDialog, {
        open: true,
        onOpenChange: vi.fn(),
        repo: githubRepo,
        onCreateEdition: vi.fn(),
      })
    );
    expect(htmlGithub).toContain('转录新版本');
  });
});
