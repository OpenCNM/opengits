import { describe, it, expect } from 'vitest';
import {
  useImportWizardStore,
  wizardFlow,
  createInitialWizardData,
  getWizardLifecycleState,
  getWizardCloseAction,
  canProceedToOutline,
  canProceedToIngest,
  type ImportWizardData,
} from '@/lib/stores/import-wizard-store';
import { countEffectiveChars, shouldShowAiExpand } from '@/components/ImportWizard/workbench/ai-expand-eligibility';

describe('ImportWizard Finite State Machine (FSM) & Guard Contracts', () => {
  it('getWizardLifecycleState: IDLE / DISCOVERING / CURATING / SUBMITTING / HANDOFF / FAILED 全状态投影', () => {
    const closed = createInitialWizardData();
    expect([closed.isOpen, getWizardLifecycleState(closed)]).toEqual([false, 'IDLE']);

    for (const subStep of ['input', 'directory_confirm', 'outline_draft', 'web_confirm'] as const) {
      expect(getWizardLifecycleState({ ...closed, isOpen: true, step: 1, subStep })).toBe('DISCOVERING');
    }
    expect(getWizardLifecycleState({ ...closed, isOpen: true, step: 2 })).toBe('CURATING');
    expect(getWizardLifecycleState({ ...closed, isOpen: true, step: 3 })).toBe('SUBMITTING');
    expect(getWizardLifecycleState({ ...closed, isOpen: true, step: 3, submittedJobId: 'job-123' })).toBe('HANDOFF');
    expect(getWizardLifecycleState({ ...closed, isOpen: true, step: 3, ingestSuccessInfo: { owner: 't', repo: 's', totalDocuments: 10 } })).toBe('HANDOFF');
    expect(getWizardLifecycleState({ ...closed, isOpen: true, step: 3, ingestFailed: true })).toBe('FAILED');
  });

  it('getWizardCloseAction 关闭守卫：confirm-dirty / confirm-abort / close', () => {
    const base = createInitialWizardData();
    expect(getWizardCloseAction({ ...base, isOpen: true, step: 2, isOutlineDirty: true })).toBe('confirm-dirty');
    expect(getWizardCloseAction({ ...base, isOpen: true, step: 2, isOutlineDirty: true, ingestFailed: true })).toBe('confirm-dirty');
    expect(getWizardCloseAction({ ...base, isOpen: true, step: 3 })).toBe('confirm-abort');
    expect(getWizardCloseAction({ ...base, isOpen: true, step: 3, ingestFailed: true })).toBe('confirm-abort');
    expect(getWizardCloseAction({ ...base, isOpen: true, step: 3, submittedJobId: 'job-123' })).toBe('close');
    expect(getWizardCloseAction({ ...base, isOpen: true, step: 3, ingestSuccessInfo: { owner: 't', repo: 'r' } })).toBe('close');
    expect(getWizardCloseAction({ ...base, isOpen: true, step: 2, isOutlineDirty: false })).toBe('close');
    expect(getWizardCloseAction({ ...base, isOpen: true, step: 1 })).toBe('close');
  });

  it('canProceedToOutline & canProceedToIngest 跃迁守卫', () => {
    const base = createInitialWizardData();
    expect(canProceedToOutline(base)).toBe(false);
    expect(canProceedToOutline({ ...base, isOpen: true, loading: true, url: 'https://github.com/facebook/react' })).toBe(false);
    expect(canProceedToOutline({ ...base, isOpen: true, url: '   ' })).toBe(false);

    const ghNoScout: ImportWizardData = { ...base, isOpen: true, importMode: 'github', url: 'https://github.com/facebook/react', scoutData: null };
    expect(canProceedToOutline(ghNoScout)).toBe(false);
    expect(canProceedToOutline({ ...ghNoScout, scoutData: { owner: 'facebook', repo: 'react' }, draftOutline: { modules: [{ name: 'Core' }] } })).toBe(true);
    expect(canProceedToOutline({ ...ghNoScout, scoutData: { owner: 'facebook', repo: 'react' }, customOutline: [{ title: 'Intro' }] })).toBe(true);

    expect(canProceedToOutline({ ...base, isOpen: true, importMode: 'web', url: 'not-a-valid-url' })).toBe(false);
    expect(canProceedToOutline({ ...base, isOpen: true, importMode: 'web', url: 'https://nextjs.org/docs' })).toBe(true);

    expect(canProceedToIngest({ ...base, isOpen: true, step: 1, url: 'https://github.com/facebook/react', customOutline: [{ title: 'Intro' }] })).toBe(false);
    expect(canProceedToIngest({ ...base, isOpen: true, step: 2, url: 'https://github.com/facebook/react', customOutline: [] })).toBe(false);
    expect(canProceedToIngest({ ...base, isOpen: true, step: 2, url: 'https://github.com/facebook/react', customOutline: [{ title: 'Intro' }], isTranslatingOutline: true })).toBe(false);
    expect(canProceedToIngest({ ...base, isOpen: true, step: 2, url: 'https://github.com/facebook/react', customOutline: [{ title: 'Intro' }], isTranslatingOutline: false })).toBe(true);
  });

  it('wizardFlow GitHub & WebDoc 往返持久化状态迁移', () => {
    useImportWizardStore.setState({
      ...createInitialWizardData('en'),
      isOpen: true,
      step: 2,
      subStep: 'outline_draft',
      importMode: 'github',
      url: 'https://github.com/karpathy/nanogpt',
      scoutedUrl: 'https://github.com/karpathy/nanogpt',
      scoutData: { owner: 'karpathy', repo: 'nanogpt', branch: 'master' },
      selectedPrefix: '',
      excludedPaths: ['assets/'],
    });
    wizardFlow.goBackToInput();
    expect(useImportWizardStore.getState()).toMatchObject({ step: 1, subStep: 'input', excludedPaths: ['assets/'] });
    wizardFlow.updateTargetLanguage('zh-CN');
    expect(wizardFlow.resumeFromInput()).toBe(true);
    expect(useImportWizardStore.getState()).toMatchObject({ step: 2, subStep: 'outline_draft', targetLanguage: 'zh-CN' });

    useImportWizardStore.setState({
      ...createInitialWizardData('en'),
      isOpen: true,
      step: 1,
      subStep: 'input',
      importMode: 'github',
      url: 'https://github.com/vercel/ai',
      scoutedUrl: 'https://github.com/karpathy/nanogpt',
      scoutData: { owner: 'karpathy', repo: 'nanogpt' },
    });
    expect(wizardFlow.resumeFromInput()).toBe(false);

    useImportWizardStore.setState(createInitialWizardData('zh-CN'));
    wizardFlow.enterWebConfirm('https://coss.com/ui/docs');
    expect(useImportWizardStore.getState()).toMatchObject({ importMode: 'web', subStep: 'web_confirm', webScoutPhase: 'scouting' });

    wizardFlow.applyWebScoutResult(
      'https://coss.com/ui/docs',
      {
        status: 'ready',
        scoutStatus: 'multi_module',
        primaryDocPrefix: '/ui/docs',
        moduleTabs: [{ id: 'docs', label: 'Docs', path: '/ui/docs', kind: 'doc' }, { id: 'chat', label: 'Chat', path: '/ui/chat', kind: 'doc' }],
        sidebarHeadings: ['Intro'],
      },
      ['/ui/docs']
    );
    wizardFlow.toggleWebSelectedPath('/ui/chat');
    expect(useImportWizardStore.getState().webSelectedPaths).toEqual(['/ui/docs', '/ui/chat']);

    wizardFlow.goBackToInput();
    wizardFlow.enterWebConfirm('https://coss.com/ui/docs');
    expect(useImportWizardStore.getState()).toMatchObject({ subStep: 'web_confirm', webScoutPhase: 'ready', webSelectedPaths: ['/ui/docs', '/ui/chat'] });

    useImportWizardStore.setState({ step: 3, ingestFailed: true });
    wizardFlow.goBackToScope();
    expect(useImportWizardStore.getState()).toMatchObject({ step: 1, subStep: 'web_confirm', webScoutPhase: 'ready', ingestFailed: false });
  });

  it('ai-expand-eligibility 有效字符统计、4~100 黄金窗口与结构化/选区门禁', () => {
    expect(countEffectiveChars('  跳过跨端、重点剖析网关！ ')).toBe(10);
    expect(countEffectiveChars('I use Rust.')).toBe(8);
    expect(countEffectiveChars('...   ')).toBe(0);

    expect(shouldShowAiExpand({ text: '' })).toBe(false);
    expect(shouldShowAiExpand({ text: '跳过跨端', isComposing: true })).toBe(false);
    expect(shouldShowAiExpand({ text: '跳过跨端', isExpanding: true })).toBe(false);
    expect(shouldShowAiExpand({ text: '跳过跨端', hasExpandedDraft: true })).toBe(false);
    expect(shouldShowAiExpand({ text: '跳过跨端', hasOutline: false })).toBe(false);

    const expanded = '跳过跨端适配细节，重点剖析网关路由与鉴权链路。';
    expect(shouldShowAiExpand({ text: expanded, lastExpandedPrompt: expanded })).toBe(false);
    expect(shouldShowAiExpand({ text: `${expanded} 补充缓存`, lastExpandedPrompt: expanded })).toBe(true);

    expect(shouldShowAiExpand({ text: '网关' })).toBe(false);
    expect(shouldShowAiExpand({ text: '跳过跨端' })).toBe(true);
    expect(shouldShowAiExpand({ text: '一'.repeat(100) })).toBe(true);
    expect(shouldShowAiExpand({ text: '一'.repeat(101) })).toBe(false);
    expect(
      shouldShowAiExpand({
        text: '只看UI界面设计与实现，与底层agent的连接交互，主要是状态机设计、执行成功与失败的设计等等，所有关于UI与底层的通信与交互',
      })
    ).toBe(true);

    expect(shouldShowAiExpand({ text: '第一部分讲路由\n第二部分讲鉴权\n第三部分讲限流' })).toBe(false);
    expect(shouldShowAiExpand({ text: '1. 跳过跨端适配\n2. 重点剖析网关' })).toBe(false);
    expect(shouldShowAiExpand({ text: '1. 跳过跨端适配\n2. 重点剖析网关\n3. 补充限流策略', selectionLength: 4 })).toBe(true);
  });
});
