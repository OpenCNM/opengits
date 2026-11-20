import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useModalStore } from '@/lib/stores/modal-store';
import { useModelProviderStore } from '@/lib/stores/model-provider-store';
import { hasConfiguredApiKey, requireApiKey } from '@/lib/api-key-guard';
import { STORAGE_KEYS } from '@/lib/constants';
import type { UserModelProviderDTO } from '@/types/user-model-provider';

describe('useModalStore 与 useModelProviderStore 业务集成联动', () => {
  const storeMap = new Map<string, string>();

  beforeEach(() => {
    storeMap.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storeMap.get(k) ?? null,
      setItem: (k: string, v: string) => storeMap.set(k, String(v)),
      removeItem: (k: string) => storeMap.delete(k),
      clear: () => storeMap.clear(),
    });
    vi.stubGlobal('window', {
      dispatchEvent: () => true,
    });
    useModalStore.getState().closeApiKeyModal();
    useModalStore.getState().closePreferencesModal();
    useModelProviderStore.setState({
      userProviders: [],
      dynamicProviders: [],
      isInitialized: false,
      loadedUserId: null,
    });
  });

  it('openApiKeyModal 能够注入 contextText 与 onCompleted 回调', () => {
    let completed = false;
    useModalStore.getState().openApiKeyModal({
      contextText: '导入前请先配置 Key',
      onCompleted: () => {
        completed = true;
      },
    });

    const state = useModalStore.getState();
    expect(state.apiKeyModalOpen).toBe(true);
    expect(state.apiKeyModalOptions?.contextText).toBe('导入前请先配置 Key');

    state.apiKeyModalOptions?.onCompleted?.();
    expect(completed).toBe(true);
  });

  it('requireApiKey 未配 Key 时拦截并唤起 Onboarding 弹窗，已配 Key 时直接放行', () => {
    let actionRan = false;

    // 1. 未配置 Key：拦截
    const passed1 = requireApiKey(() => {
      actionRan = true;
    }, '测试拦截');
    expect(passed1).toBe(false);
    expect(actionRan).toBe(false);
    expect(useModalStore.getState().apiKeyModalOpen).toBe(true);

    // 2. 配置 Key 后：放行
    localStorage.setItem(STORAGE_KEYS.VAR_API_KEY, 'sk-valid-key-123');
    expect(hasConfiguredApiKey()).toBe(true);

    const passed2 = requireApiKey(() => {
      actionRan = true;
    });
    expect(passed2).toBe(true);
    expect(actionRan).toBe(true);
  });

  it('useModelProviderStore: upsertProvider 与 setActiveProvider 正确同步 runtime localStorage', async () => {
    const provider1: UserModelProviderDTO = {
      providerKey: 'google',
      name: 'Google Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiFormat: 'openai',
      apiKey: 'sk-gemini-key',
      models: ['gemini-3.7-flash'],
      selectedModel: 'gemini-3.7-flash',
      isActive: true,
      healthStatus: 'healthy',
    };

    await useModelProviderStore.getState().upsertProvider(provider1);

    expect(useModelProviderStore.getState().userProviders).toHaveLength(1);
    expect(localStorage.getItem(STORAGE_KEYS.AGENT_PROVIDER)).toBe('google');
    expect(localStorage.getItem(STORAGE_KEYS.AGENT_MODEL)).toBe('gemini-3.7-flash');
    expect(localStorage.getItem(STORAGE_KEYS.VAR_API_KEY)).toBe('sk-gemini-key');
  });

  it('Cloud SSOT：已登录用户云端无配置时，即使 localStorage 有陈旧残留，hasConfiguredApiKey 仍返回 false', () => {
    localStorage.setItem(STORAGE_KEYS.VAR_API_KEY, 'sk-stale-local-key');
    useModelProviderStore.setState({
      isInitialized: true,
      loadedUserId: 'usr-cloud-empty',
      userProviders: [],
    });

    expect(hasConfiguredApiKey()).toBe(false);
  });

  it('Cloud SSOT：云端返回 hasApiKey: true（无本地明文）时，hasConfiguredApiKey 返回 true', () => {
    useModelProviderStore.setState({
      isInitialized: true,
      loadedUserId: 'usr-cloud-valid',
      userProviders: [
        {
          providerKey: 'zhipu',
          name: '智谱 GLM',
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          apiFormat: 'openai',
          hasApiKey: true,
          models: ['glm-5.3-flash'],
          selectedModel: 'glm-5.3-flash',
          isActive: true,
          healthStatus: 'healthy',
        },
      ],
    });

    expect(hasConfiguredApiKey()).toBe(true);
  });
});
