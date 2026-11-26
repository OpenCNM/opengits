import { create } from 'zustand';
import { AI_PROVIDER_PRESETS } from '@/lib/constants';
import { useModelProviderStore } from '@/lib/stores/model-provider-store';

export type ProviderFormApiFormat = 'openai' | 'anthropic';

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

export interface ProviderFormPreset {
  providerKey: string;
  name?: string;
  baseUrl?: string;
  models?: string[];
  selectedModel?: string;
}

interface ProviderFormStoreState extends ProviderFormDraftFields {
  patchDraft: (partial: Partial<ProviderFormDraftFields>) => void;
  loadPreset: (preset: ProviderFormPreset, currentBaseUrl?: string) => void;
  addFormModel: () => void;
}

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
