import { describe, expect, it, beforeEach } from 'vitest';
import {
  useImportWizardStore,
  wizardSetters,
  createWizardResetPatch,
  createInitialWizardData,
} from '@/lib/stores/import-wizard-store';

describe('import-wizard-store（导入向导状态数据层）', () => {
  beforeEach(() => {
    useImportWizardStore.setState(createInitialWizardData('en'));
  });

  it('字段级 setter 支持直值与函数式更新（兼容 Dispatch<SetStateAction> 签名）', () => {
    wizardSetters.setUrl('https://github.com/a/b');
    expect(useImportWizardStore.getState().url).toBe('https://github.com/a/b');

    wizardSetters.setLogs((prev) => [...prev, 'line1']);
    wizardSetters.setLogs((prev) => [...prev, 'line2']);
    expect(useImportWizardStore.getState().logs).toEqual(['line1', 'line2']);
  });

  it('createWizardResetPatch：重置向导会话字段到初始值', () => {
    wizardSetters.setStep(3);
    wizardSetters.setUrl('https://github.com/a/b');
    wizardSetters.setScoutData({ owner: 'a', repo: 'b' });
    wizardSetters.setIngestFailed(true);

    useImportWizardStore.setState(createWizardResetPatch('zh-CN'));

    const s = useImportWizardStore.getState();
    expect(s.step).toBe(1);
    expect(s.subStep).toBe('input');
    expect(s.isOpen).toBe(false);
    expect(s.url).toBe('');
    expect(s.scoutData).toBeNull();
    expect(s.ingestFailed).toBe(false);
    expect(s.targetLanguage).toBe('zh-CN');
  });

  it('createWizardResetPatch 刻意不触碰的字段保持原值（与原手工 reset 集合一致）', () => {
    wizardSetters.setLoading(true);
    wizardSetters.setTagPool(['AI']);
    wizardSetters.setTranslatingIndices(new Set(['file-0-1']));

    useImportWizardStore.setState(createWizardResetPatch('en'));

    const s = useImportWizardStore.getState();
    // 原实现 resetWizard 不重置 loading / tagPool / translatingIndices
    expect(s.loading).toBe(true);
    expect(s.tagPool).toEqual(['AI']);
    expect(s.translatingIndices.size).toBe(1);
  });

  it('createInitialWizardData：locale 决定 targetLanguage 初始值', () => {
    expect(createInitialWizardData('zh-CN').targetLanguage).toBe('zh-CN');
    expect(createInitialWizardData(null).targetLanguage).toBe('en');
  });

  it('targetLanguage：用户在向导中主动设定的目标语言具有主权，不被界面 locale 覆盖', () => {
    wizardSetters.setTargetLanguage('en');
    expect(useImportWizardStore.getState().targetLanguage).toBe('en');
  });

  it('draftSteps：支持追加步骤并在 resetWizard 时重置', () => {
    wizardSetters.setDraftSteps([
      { stage: 'scope', tag: '目录锁定', title: '锁定目标目录范围', detail: '已定位 49 个待规划文件' },
    ]);
    expect(useImportWizardStore.getState().draftSteps).toHaveLength(1);

    useImportWizardStore.setState(createWizardResetPatch('zh-CN'));
    expect(useImportWizardStore.getState().draftSteps).toEqual([]);
  });

  it('collapsedCategories：初始为空对象，章节默认折叠，支持显式展开与重新折叠', () => {
    // 初始状态下 collapsedCategories 为空对象
    expect(useImportWizardStore.getState().collapsedCategories).toEqual({});

    // 默认折叠判定规则：prev[idx] !== false（未显式设为 false 时均为折叠）
    const isCollapsed = (idx: number) => {
      const map = useImportWizardStore.getState().collapsedCategories;
      return map[idx] !== false;
    };

    expect(isCollapsed(0)).toBe(true);
    expect(isCollapsed(1)).toBe(true);

    // 模拟 toggleCategory 展开第 0 章
    const toggle = (idx: number) => {
      wizardSetters.setCollapsedCategories((prev) => {
        const currentlyCollapsed = prev[idx] !== false;
        return { ...prev, [idx]: !currentlyCollapsed };
      });
    };

    toggle(0);
    expect(isCollapsed(0)).toBe(false); // 第 0 章展开
    expect(isCollapsed(1)).toBe(true);  // 第 1 章依然默认折叠

    // 再次点击第 0 章折叠收起
    toggle(0);
    expect(isCollapsed(0)).toBe(true);

    // 重置向导后恢复初始空状态
    useImportWizardStore.setState(createWizardResetPatch('zh-CN'));
    expect(useImportWizardStore.getState().collapsedCategories).toEqual({});
  });

  it('enterOrchestration：进入步骤 2 原子初始化大纲推导上下文与清理残留变量', () => {
    wizardSetters.setCustomOutline([{ name: 'Old Chapter', files: [] }]);
    wizardSetters.setOutlineGenError('Previous error');
    wizardSetters.setIsOutlineDirty(true);
    wizardSetters.setHasRecoverableDraft(true);
    wizardSetters.setDraftOutline({ modules: [{ name: 'Stale' }] });

    wizardSetters.enterOrchestration();

    const s = useImportWizardStore.getState();
    expect(s.step).toBe(2);
    expect(s.customOutline).toEqual([]);
    expect(s.outlineGenError).toBeNull();
    expect(s.draftLoading).toBe(true);
    expect(s.isOutlineDirty).toBe(false);
    expect(s.hasRecoverableDraft).toBe(false);
    expect(s.draftOutline).toBeNull();
    expect(s.collapsedCategories).toEqual({});
  });

  it('createWizardResetPatch：重置 outlineGenError 到初始值', () => {
    wizardSetters.setOutlineGenError('Some error occurred');
    expect(useImportWizardStore.getState().outlineGenError).toBe('Some error occurred');

    useImportWizardStore.setState(createWizardResetPatch('zh-CN'));
    expect(useImportWizardStore.getState().outlineGenError).toBeNull();
  });
});
