import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { setLocale } from '@/paraglide/runtime.js';

const wizardMock = {
  step: 1,
  subStep: 'input' as 'input' | 'directory_confirm' | 'outline_draft' | 'web_confirm',
  importMode: 'github' as 'github' | 'web',
  webScoutPhase: 'idle' as 'idle' | 'scouting' | 'ready' | 'failed',
  url: '',
  loading: false,
  isReauthorizing: false,
  prefixLoading: false,
  scoutSteps: [],
  scoutData: null as { owner?: string; repo?: string } | null,
  dedupInfo: null as { existsInExplore?: boolean } | null,
  scoutSameSource: null,
  hasDismissedDedup: false,
  scoutError: null,
  targetLanguage: 'zh-CN',
  teachingDepth: 'standard' as const,
  customPrompt: '',
  isPublic: true,
  setUrl: vi.fn(),
  setSubStep: vi.fn(),
  setStep: vi.fn(),
  setWebScoutPhase: vi.fn(),
  setHasDismissedDedup: vi.fn(),
  setScoutError: vi.fn(),
  setTargetLanguage: vi.fn(),
  setTeachingDepth: vi.fn(),
  setCustomPrompt: vi.fn(),
  setIsPublic: vi.fn(),
  handleScout: vi.fn(async () => {}),
  submitWebDocImport: vi.fn(async () => {}),
  retryWebDocImport: vi.fn(async () => {}),
  handleCloseRequest: vi.fn(),
  resetWizard: vi.fn(),
};

const storeMockState = {
  isOpen: true,
  step: 1,
  subStep: 'input',
  url: '',
  scoutedUrl: '',
  loading: false,
  prefixLoading: false,
  scoutData: null,
  webScoutState: null,
  webScopeMode: 'recommended' as const,
  webSelectedPaths: [] as string[],
  ingestSuccessInfo: null as { owner: string; repo: string } | null,
  ingestFailed: false,
  scoutError: null,
  importMode: 'web' as const,
  customOutline: [],
  logs: [] as string[],
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/components/ImportWizard/ImportWizardContext', () => ({
  useImportWizard: () => wizardMock,
}));

vi.mock('@/lib/stores/import-wizard-store', () => ({
  useImportWizardStore: (selector: (s: typeof storeMockState) => unknown) => selector(storeMockState),
  wizardFlow: {
    goBackToInput: vi.fn(),
    resumeFromInput: vi.fn(() => false),
    goBackToScope: vi.fn(),
    enterWebConfirm: vi.fn(),
    applyWebScoutResult: vi.fn(),
    setWebScopeMode: vi.fn(),
    setWebSelectedPaths: vi.fn(),
    toggleWebSelectedPath: vi.fn(),
    updateTargetLanguage: vi.fn(),
  },
}));

vi.mock('@/components/ImportWizard/common/WizardModelSelector', () => ({
  WizardModelSelector: () => React.createElement('span', { 'data-testid': 'github-model-selector' }, 'ModelSelector'),
}));

vi.mock('@/components/ImportWizard/ScoutFeedbackCard', () => ({
  ScoutFeedbackCard: () => React.createElement('div', { 'data-testid': 'github-scout-feedback' }),
}));

import { Step1URLInput } from '@/components/ImportWizard/Step1URLInput';
import { WebDocImportFlow } from '@/components/ImportWizard/webdoc/WebDocImportFlow';

describe('GitHub vs WebDoc UI 彻底解耦回归测试', () => {
  beforeEach(() => {
    setLocale('zh-CN');
    vi.clearAllMocks();
    wizardMock.step = 1;
    wizardMock.subStep = 'input';
    wizardMock.importMode = 'github';
    wizardMock.url = '';
    storeMockState.step = 1;
    storeMockState.subStep = 'input';
    storeMockState.ingestSuccessInfo = null;
    storeMockState.ingestFailed = false;
    storeMockState.logs = [];
  });

  it('Step1URLInput 输入 WebDoc URL 时彻底隐藏语言/模型/深度/公共开关，仅显示下一步', () => {
    wizardMock.url = 'https://coss.com/ui/docs';
    const html = renderToString(React.createElement(Step1URLInput));

    expect(html).toContain('网页文档导入');
    expect(html).not.toContain('导入新仓库');
    expect(html).toContain('下一步：嗅探站点目录');
    expect(html).not.toContain('语言偏好');
    expect(html).not.toContain('data-testid="github-model-selector"');
    expect(html).not.toContain('教程深度');
    expect(html).not.toContain('公开教程 · 赚取积分');
  });

  it('Step1URLInput 输入 GitHub 仓库 URL 时完整保留 GitHub 配置面板', () => {
    wizardMock.url = 'https://github.com/vercel/ai';
    const html = renderToString(React.createElement(Step1URLInput));

    expect(html).toContain('导入新仓库');
    expect(html).toContain('语言偏好');
    expect(html).toContain('data-testid="github-model-selector"');
    expect(html).toContain('教程深度');
    expect(html).toContain('公开教程 · 赚取积分');
    expect(html).not.toContain('下一步：嗅探站点目录');
  });

  it('Step1URLInput 在 subStep=input 时即使存在查重信息也不被 DedupNoticeCard 劫持，且同 URL 缓存显示继续按钮', () => {
    wizardMock.subStep = 'input';
    wizardMock.importMode = 'github';
    wizardMock.url = 'https://github.com/karpathy/nanogpt';
    wizardMock.dedupInfo = { existsInExplore: true };
    wizardMock.scoutData = { owner: 'karpathy', repo: 'nanogpt' };
    storeMockState.scoutedUrl = 'https://github.com/karpathy/nanogpt';

    const html = renderToString(React.createElement(Step1URLInput));

    expect(html).not.toContain('data-testid="github-scout-feedback"');
    expect(html).toContain('语言偏好');
    expect(html).toContain('继续');

    wizardMock.dedupInfo = null;
    wizardMock.scoutData = null;
    storeMockState.scoutedUrl = '';
  });

  it('WebDocImportFlow 在 step=3 使用极简进度条与阶段文案，不显示原始计数日志', () => {
    wizardMock.step = 3;
    wizardMock.subStep = 'web_confirm';
    wizardMock.importMode = 'web';
    wizardMock.url = 'https://coss.com/ui/docs';
    storeMockState.step = 3;
    storeMockState.subStep = 'web_confirm';
    storeMockState.logs = [
      '[1/3] 识别静态入口: 《Introduction》，发现 73 个文档链接',
      '[2/3] 正在抓取: Skills (5/68)...',
      '[2/3] 正在抓取: useMediaQuery (65/69)...',
    ];

    const html = renderToString(React.createElement(WebDocImportFlow));

    expect(html).toContain('data-slot="progress"');
    expect(html).toContain('正在抓取并清洗文档页面内容…');
    expect(html).not.toContain('65/69');
    expect(html).not.toContain('73 个');
    expect(html).not.toContain('处理日志');
    expect(html).not.toContain('课程大纲编排');

    storeMockState.ingestSuccessInfo = { owner: 'web-docs', repo: 'coss-com' };
    const readyHtml = renderToString(React.createElement(WebDocImportFlow));
    expect(readyHtml).toContain('网页文档已就绪');
    expect(readyHtml).toContain('立即开始阅读');
    expect(readyHtml).not.toContain('处理日志');
  });
});
