import { create } from 'zustand';
import { AI_PROVIDER_PRESETS } from '@/lib/constants';
import { useModelProviderStore } from '@/lib/stores/model-provider-store';

export type ProviderFormApiFormat = 'openai' | 'anthropic';

/** 服务商表单草稿字段（纯 UI 态，不持久化到 localStorage） */
export interface ProviderFormDraftFields {
  formProviderKey: string;
  formName: string;
  formBaseUrl: string;
  formApiKey: string;
  formApiFormat: ProviderFormApiFormat;
  formModels: string[];
  formSelectedModel: string;
  formIsActive: boolean;
  showApiKey: boolean;
  isAddingFormModel: boolean;
  formNewModelName: string;
}

/**
 * 批量载入草稿的预设载荷。
 * 仅 providerKey 必填；其余字段作为 dynamic provider 与内置预设均未命中时的兜底值。
 */
export interface ProviderFormPreset {
  providerKey: string;
  name?: string;
  baseUrl?: string;
  models?: string[];
  selectedModel?: string;
}

interface ProviderFormStoreState extends ProviderFormDraftFields {
  /** 局部更新草稿字段（等价于原先散落在 PreferencesModal 的各 setFormXxx） */
  patchDraft: (partial: Partial<ProviderFormDraftFields>) => void;
  /**
   * 按预设批量载入草稿（原 PreferencesModal.resetFormWithPreset 逻辑照搬）：
   * 动态服务商 > 内置预设 > 调用方兜底 > 空值；并清空 API Key、收起附加 UI。
   * currentBaseUrl 仅在以上来源都未给出 baseUrl 时兜底。
   */
  loadPreset: (preset: ProviderFormPreset, currentBaseUrl?: string) => void;
  /** 原 onAddFormModel：去重后追加模型并选中，随后收起输入框 */
  addFormModel: () => void;
}

// 初始草稿 = 迁移前 PreferencesModal 中各 useState 的初始值（零行为迁移）
const INITIAL_DRAFT: ProviderFormDraftFields = {
  formProviderKey: 'google',
  formName: 'Google Gemini',
  formBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  formApiKey: '',
  formApiFormat: 'openai',
  formModels: ['gemini-3.7-flash', 'gemini-3.1-pro', 'gemini-3.6-flash'],
  formSelectedModel: 'gemini-3.7-flash',
  formIsActive: true,
  showApiKey: false,
  isAddingFormModel: false,
  formNewModelName: '',
};

export const useProviderFormStore = create<ProviderFormStoreState>((set, get) => ({
  ...INITIAL_DRAFT,

  patchDraft: (partial) => set(partial),

  loadPreset: (preset, currentBaseUrl) => {
    const { dynamicProviders, userProviders } = useModelProviderStore.getState();
    const dyn = dynamicProviders.find((p) => p.providerKey === preset.providerKey);
    const builtin = AI_PROVIDER_PRESETS[preset.providerKey];

    set({
      formProviderKey: preset.providerKey,
      formName: dyn?.name || builtin?.name || preset.name || '自定义服务商',
      formBaseUrl: dyn?.baseUrl || builtin?.baseUrl || preset.baseUrl || currentBaseUrl || '',
      formApiFormat: dyn?.apiFormat || builtin?.apiFormat || 'openai',
      formModels: dyn?.models || builtin?.models || preset.models || [],
      formSelectedModel: dyn?.models?.[0] || builtin?.models?.[0] || preset.selectedModel || '',
      formApiKey: '',
      formIsActive: userProviders.length === 0,
      showApiKey: false,
    });
  },

  addFormModel: () => {
    const { formNewModelName, formModels } = get();
    const trimmed = formNewModelName.trim();
    if (trimmed && !formModels.includes(trimmed)) {
      set({ formModels: [...formModels, trimmed], formSelectedModel: trimmed });
    }
    set({ formNewModelName: '', isAddingFormModel: false });
  },
}));
