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

describe('ImportWizard Finite State Machine (FSM) & Guard Contracts', () => {
  it('returns IDLE lifecycle when the wizard is closed', () => {
    const data = createInitialWizardData();
    expect(data.isOpen).toBe(false);
    expect(getWizardLifecycleState(data)).toBe('IDLE');
  });

  it('maps Step 1 (any subStep) to DISCOVERING（subStep 为路由细节，不进入宏观词汇）', () => {
    const data: ImportWizardData = {
      ...createInitialWizardData(),
      isOpen: true,
      step: 1,
      subStep: 'input',
    };
    for (const subStep of ['input', 'directory_confirm', 'outline_draft', 'web_confirm'] as const) {
      data.subStep = subStep;
      expect(getWizardLifecycleState(data)).toBe('DISCOVERING');
    }
  });

  it('maps to CURATING lifecycle when in Step 2', () => {
    const data: ImportWizardData = {
      ...createInitialWizardData(),
      isOpen: true,
      step: 2,
    };
    expect(getWizardLifecycleState(data)).toBe('CURATING');
  });

  it('correctly determines Step 3 execution states (SUBMITTING, HANDOFF, FAILED)', () => {
    const baseStep3: ImportWizardData = {
      ...createInitialWizardData(),
      isOpen: true,
      step: 3,
    };

    expect(getWizardLifecycleState(baseStep3)).toBe('SUBMITTING');

    // Job 已入库 → HANDOFF（即使跟随流尚未完成）
    const handedOff: ImportWizardData = {
      ...baseStep3,
      submittedJobId: 'job-123',
    };
    expect(getWizardLifecycleState(handedOff)).toBe('HANDOFF');

    const completedState: ImportWizardData = {
      ...baseStep3,
      ingestSuccessInfo: {
        owner: 'test',
        repo: 'sample',
        totalDocuments: 10,
      },
    };
    expect(getWizardLifecycleState(completedState)).toBe('HANDOFF');

    const failedState: ImportWizardData = {
      ...baseStep3,
      ingestFailed: true,
    };
    expect(getWizardLifecycleState(failedState)).toBe('FAILED');
  });

  describe('projectWizardCloseAction close guard（handleCloseRequest 单一决策源）', () => {
    it('Step 2 大纲脏 → confirm-dirty（优先级最高，残留 ingestFailed 也不静默丢弃）', () => {
      const data: ImportWizardData = {
        ...createInitialWizardData(),
        isOpen: true,
        step: 2,
        isOutlineDirty: true,
      };
      expect(getWizardCloseAction(data)).toBe('confirm-dirty');

      const withLingeringFailure = { ...data, ingestFailed: true };
      expect(getWizardCloseAction(withLingeringFailure)).toBe('confirm-dirty');
    });

    it('Step 3 无 Job 存续（含 FAILED）→ confirm-abort', () => {
      const data: ImportWizardData = {
        ...createInitialWizardData(),
        isOpen: true,
        step: 3,
      };
      expect(getWizardCloseAction(data)).toBe('confirm-abort');

      const failed = { ...data, ingestFailed: true };
      expect(getWizardCloseAction(failed)).toBe('confirm-abort');
    });

    it('Job 已入库（HANDOFF）或已完成 → 直接 close，绝不误弹终止流水线确认', () => {
      const handedOff: ImportWizardData = {
        ...createInitialWizardData(),
        isOpen: true,
        step: 3,
        submittedJobId: 'job-123',
      };
      expect(getWizardCloseAction(handedOff)).toBe('close');

      const completed: ImportWizardData = {
        ...createInitialWizardData(),
        isOpen: true,
        step: 3,
        ingestSuccessInfo: { owner: 't', repo: 'r' },
      };
      expect(getWizardCloseAction(completed)).toBe('close');
    });

    it('干净的大纲与 Step 1 → 直接 close', () => {
      const cleanStep2: ImportWizardData = {
        ...createInitialWizardData(),
        isOpen: true,
        step: 2,
        isOutlineDirty: false,
      };
      expect(getWizardCloseAction(cleanStep2)).toBe('close');

      const step1: ImportWizardData = {
        ...createInitialWizardData(),
        isOpen: true,
        step: 1,
      };
      expect(getWizardCloseAction(step1)).toBe('close');
    });
  });

  describe('canProceedToOutline transition guard', () => {
    it('rejects when closed or loading or url is empty', () => {
      const closed = createInitialWizardData();
      expect(canProceedToOutline(closed)).toBe(false);

      const loading: ImportWizardData = {
        ...createInitialWizardData(),
        isOpen: true,
        loading: true,
        url: 'https://github.com/facebook/react',
      };
      expect(canProceedToOutline(loading)).toBe(false);

      const emptyUrl: ImportWizardData = {
        ...createInitialWizardData(),
        isOpen: true,
        loading: false,
        url: '   ',
      };
      expect(canProceedToOutline(emptyUrl)).toBe(false);
    });

    it('validates github import requirements', () => {
      const githubNoScout: ImportWizardData = {
        ...createInitialWizardData(),
        isOpen: true,
        importMode: 'github',
        url: 'https://github.com/facebook/react',
        scoutData: null,
      };
      expect(canProceedToOutline(githubNoScout)).toBe(false);

      const githubWithDraft: ImportWizardData = {
        ...githubNoScout,
        scoutData: { owner: 'facebook', repo: 'react' },
        draftOutline: { modules: [{ name: 'Core' }] },
      };
      expect(canProceedToOutline(githubWithDraft)).toBe(true);

      const githubWithCustomOutline: ImportWizardData = {
        ...githubNoScout,
        scoutData: { owner: 'facebook', repo: 'react' },
        customOutline: [{ title: 'Intro' }],
      };
      expect(canProceedToOutline(githubWithCustomOutline)).toBe(true);
    });

    it('validates web import requirements', () => {
      const webInvalid: ImportWizardData = {
        ...createInitialWizardData(),
        isOpen: true,
        importMode: 'web',
        url: 'not-a-valid-url',
      };
      expect(canProceedToOutline(webInvalid)).toBe(false);

      const webValid: ImportWizardData = {
        ...createInitialWizardData(),
        isOpen: true,
        importMode: 'web',
        url: 'https://nextjs.org/docs',
      };
      expect(canProceedToOutline(webValid)).toBe(true);
    });
  });

  describe('canProceedToIngest transition guard', () => {
    it('rejects when step is not 2', () => {
      const step1: ImportWizardData = {
        ...createInitialWizardData(),
        isOpen: true,
        step: 1,
        url: 'https://github.com/facebook/react',
        customOutline: [{ title: 'Intro' }],
      };
      expect(canProceedToIngest(step1)).toBe(false);
    });

    it('rejects when outline is translating or empty', () => {
      const emptyOutline: ImportWizardData = {
        ...createInitialWizardData(),
        isOpen: true,
        step: 2,
        url: 'https://github.com/facebook/react',
        customOutline: [],
      };
      expect(canProceedToIngest(emptyOutline)).toBe(false);

      const translating: ImportWizardData = {
        ...emptyOutline,
        customOutline: [{ title: 'Intro' }],
        isTranslatingOutline: true,
      };
      expect(canProceedToIngest(translating)).toBe(false);
    });

    it('allows proceeding when step 2 has outline and not translating', () => {
      const valid: ImportWizardData = {
        ...createInitialWizardData(),
        isOpen: true,
        step: 2,
        url: 'https://github.com/facebook/react',
        customOutline: [{ title: 'Intro' }],
        isTranslatingOutline: false,
      };
      expect(canProceedToIngest(valid)).toBe(true);
    });
  });

  describe('unified GitHub & WebDoc lifecycle transitions (wizardFlow)', () => {
    it('GitHub: goBackToInput 保留 scoutData 与偏好，修改语言后 resumeFromInput 免重跑恢复到 directory_confirm', () => {
      useImportWizardStore.setState({
        ...createInitialWizardData('en'),
        isOpen: true,
        step: 1,
        subStep: 'directory_confirm',
        importMode: 'github',
        url: 'https://github.com/karpathy/nanogpt',
        scoutedUrl: 'https://github.com/karpathy/nanogpt',
        scoutData: { owner: 'karpathy', repo: 'nanogpt', branch: 'master' },
        selectedPrefix: '',
        excludedPaths: ['assets/'],
      });

      wizardFlow.goBackToInput();
      let s = useImportWizardStore.getState();
      expect(s.step).toBe(1);
      expect(s.subStep).toBe('input');
      expect(s.scoutData?.repo).toBe('nanogpt');
      expect(s.excludedPaths).toEqual(['assets/']);

      wizardFlow.updateTargetLanguage('zh-CN');
      const resumed = wizardFlow.resumeFromInput();
      expect(resumed).toBe(true);

      s = useImportWizardStore.getState();
      expect(s.step).toBe(1);
      expect(s.subStep).toBe('directory_confirm');
      expect(s.targetLanguage).toBe('zh-CN');
      expect(s.excludedPaths).toEqual(['assets/']);
    });

    it('GitHub: URL 变更后 resumeFromInput 返回 false（触发新仓库探测）', () => {
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
    });

    it('WebDoc: enterWebConfirm / applyWebScoutResult / goBackToInput / goBackToScope 完整持久化嗅探快照', () => {
      useImportWizardStore.setState(createInitialWizardData('zh-CN'));

      wizardFlow.enterWebConfirm('https://coss.com/ui/docs');
      let s = useImportWizardStore.getState();
      expect(s.importMode).toBe('web');
      expect(s.subStep).toBe('web_confirm');
      expect(s.webScoutPhase).toBe('scouting');
      expect(s.webScoutState?.status).toBe('loading');

      wizardFlow.applyWebScoutResult(
        'https://coss.com/ui/docs',
        {
          status: 'ready',
          scoutStatus: 'multi_module',
          primaryDocPrefix: '/ui/docs',
          moduleTabs: [
            { id: 'docs', label: 'Docs', path: '/ui/docs', kind: 'doc' },
            { id: 'chat', label: 'Chat', path: '/ui/chat', kind: 'doc' },
          ],
          sidebarHeadings: ['Intro'],
        },
        ['/ui/docs']
      );
      wizardFlow.toggleWebSelectedPath('/ui/chat');

      s = useImportWizardStore.getState();
      expect(s.webScoutPhase).toBe('ready');
      expect(s.webSelectedPaths).toEqual(['/ui/docs', '/ui/chat']);

      // 返回输入页再切回 web_confirm：复用缓存，不重置勾选与就绪状态
      wizardFlow.goBackToInput();
      expect(useImportWizardStore.getState().webScoutPhase).toBe('idle');
      expect(useImportWizardStore.getState().subStep).toBe('input');

      wizardFlow.enterWebConfirm('https://coss.com/ui/docs');
      s = useImportWizardStore.getState();
      expect(s.subStep).toBe('web_confirm');
      expect(s.webScoutPhase).toBe('ready');
      expect(s.webSelectedPaths).toEqual(['/ui/docs', '/ui/chat']);

      // 从 Step 3 失败回退：goBackToScope 原子落回 web_confirm + ready
      useImportWizardStore.setState({ step: 3, ingestFailed: true });
      wizardFlow.goBackToScope();
      s = useImportWizardStore.getState();
      expect(s.step).toBe(1);
      expect(s.subStep).toBe('web_confirm');
      expect(s.webScoutPhase).toBe('ready');
      expect(s.ingestFailed).toBe(false);
    });
  });
});
