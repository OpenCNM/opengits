import { create } from 'zustand';
import type { DeepDiveContext } from '@/lib/code-viewport/explain-context';

export type { DeepDiveContext };

export interface ApiKeyModalOptions {
  contextSubtitle?: string;
  contextText?: string;
  onCompleted?: () => void;
}

interface ModalStoreState {
  apiKeyModalOpen: boolean;
  apiKeyModalOptions: ApiKeyModalOptions | null;

  preferencesModalOpen: boolean;

  askAiPayload: {
    text: string;
    timestamp: number;
  } | null;

  deepDivePayload: (DeepDiveContext & {
    timestamp: number;
  }) | null;

  isChatDrawerOpen: boolean;

  openApiKeyModal: (options?: ApiKeyModalOptions) => void;
  closeApiKeyModal: () => void;

  openPreferencesModal: (tab?: 'llm' | 'general') => void;
  closePreferencesModal: () => void;

  openAskAi: (text: string) => void;
  clearAskAi: () => void;

  triggerDeepDive: (input: string | DeepDiveContext) => void;
  clearDeepDive: () => void;

  openChatDrawer: () => void;
  closeChatDrawer: () => void;
  toggleChatDrawer: () => void;
}

export const useModalStore = create<ModalStoreState>((set) => ({
  apiKeyModalOpen: false,
  apiKeyModalOptions: null,

  preferencesModalOpen: false,

  askAiPayload: null,
  deepDivePayload: null,
  isChatDrawerOpen: false,

  openApiKeyModal: (options) =>
    set({
      apiKeyModalOpen: true,
      apiKeyModalOptions: options || null,
    }),
  closeApiKeyModal: () =>
    set({
      apiKeyModalOpen: false,
      apiKeyModalOptions: null,
    }),

  openPreferencesModal: (_tab?: 'llm' | 'general') =>
    set({
      preferencesModalOpen: true,
    }),
  closePreferencesModal: () =>
    set({
      preferencesModalOpen: false,
    }),

  openAskAi: (text: string) =>
    set({
      askAiPayload: { text, timestamp: Date.now() },
    }),
  clearAskAi: () => set({ askAiPayload: null }),

  triggerDeepDive: (input: string | DeepDiveContext) => {
    const context: DeepDiveContext = typeof input === 'string' ? { code: input } : input;
    set({
      deepDivePayload: { ...context, timestamp: Date.now() },
    });
  },
  clearDeepDive: () => set({ deepDivePayload: null }),

  openChatDrawer: () => set({ isChatDrawerOpen: true }),
  closeChatDrawer: () => set({ isChatDrawerOpen: false }),
  toggleChatDrawer: () => set((state) => ({ isChatDrawerOpen: !state.isChatDrawerOpen })),
}));
