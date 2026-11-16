import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useModelProviderStore } from '@/lib/stores/model-provider-store';
import { useSettingsStore } from '@/lib/stores/settings-store';
import { STORAGE_KEYS, AI_PROVIDER_PRESETS } from '@/lib/constants';
import type { UserModelProviderDTO } from '@/types/user-model-provider';

describe('用户自定义模型管理与运行时同步 (Custom Model Management & Runtime Sync)', () => {
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

    useModelProviderStore.setState({ userProviders: [], dynamicProviders: [] });
    useSettingsStore.setState({
      provider: 'google',
      model: 'gemini-3.7-flash',
      modelsList: ['gemini-3.7-flash'],
      apiKey: '',
    });
  });

  it('addModelToProvider: 成功添加自定义模型，并将其自动设为 selectedModel 及同步运行时', async () => {
    const baseDashscope: UserModelProviderDTO = {
      id: 'prov-dashscope-1',
      providerKey: 'dashscope',
      name: '阿里百炼',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiFormat: 'openai',
      apiKey: 'sk-dashscope-test-key',
      models: ['qwen3.8-max', 'qwen3.8-27b'],
      selectedModel: 'qwen3.8-max',
      isActive: true,
      healthStatus: 'healthy',
    };

    await useModelProviderStore.getState().upsertProvider(baseDashscope);

    // 添加自定义模型
    await useModelProviderStore
      .getState()
      .addModelToProvider('dashscope', 'qwen-turbo-latest');

    const updated = useModelProviderStore
      .getState()
      .userProviders.find((p) => p.providerKey === 'dashscope');

    expect(updated).toBeDefined();
    expect(updated?.models).toContain('qwen-turbo-latest');
    expect(updated?.selectedModel).toBe('qwen-turbo-latest');

    // 验证运行时与 localStorage 同步
    expect(localStorage.getItem(STORAGE_KEYS.AGENT_MODEL)).toBe('qwen-turbo-latest');
    expect(useSettingsStore.getState().model).toBe('qwen-turbo-latest');
    expect(useSettingsStore.getState().modelsList).toContain('qwen-turbo-latest');
  });

  it('addModelToProvider: 重复添加相同模型名称时幂等防重', async () => {
    const baseGoogle: UserModelProviderDTO = {
      id: 'prov-google-1',
      providerKey: 'google',
      name: 'Google Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiFormat: 'openai',
      apiKey: 'sk-google-key',
      models: ['gemini-3.7-flash', 'gemini-3.1-pro'],
      selectedModel: 'gemini-3.7-flash',
      isActive: true,
      healthStatus: 'healthy',
    };

    await useModelProviderStore.getState().upsertProvider(baseGoogle);

    const initialModelsCount =
      useModelProviderStore.getState().userProviders[0].models.length;

    // 重复添加已有模型
    await useModelProviderStore
      .getState()
      .addModelToProvider('google', 'gemini-3.7-flash');

    const providerAfter = useModelProviderStore.getState().userProviders[0];
    expect(providerAfter.models.length).toBe(initialModelsCount);
  });

  it('removeModelFromProvider: 移除当前选中模型时，自动回退到其余可用模型', async () => {
    const provider: UserModelProviderDTO = {
      id: 'prov-custom-1',
      providerKey: 'custom',
      name: '自定义端点',
      baseUrl: 'https://api.example.com/v1',
      apiFormat: 'openai',
      apiKey: 'sk-custom-key',
      models: ['model-a', 'model-b', 'model-c'],
      selectedModel: 'model-b',
      isActive: true,
      healthStatus: 'healthy',
    };

    await useModelProviderStore.getState().upsertProvider(provider);

    // 移除当前选中的 model-b
    await useModelProviderStore
      .getState()
      .removeModelFromProvider('custom', 'model-b');

    const updated = useModelProviderStore
      .getState()
      .userProviders.find((p) => p.providerKey === 'custom');

    expect(updated?.models).not.toContain('model-b');
    expect(updated?.models).toEqual(['model-a', 'model-c']);
    // 回退到剩余的第一个模型 model-a
    expect(updated?.selectedModel).toBe('model-a');
    expect(useSettingsStore.getState().model).toBe('model-a');
  });

  it('removeModelFromProvider: 当仅剩一个模型时拒绝移除（保证至少保留一个模型）', async () => {
    const provider: UserModelProviderDTO = {
      id: 'prov-single-1',
      providerKey: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiFormat: 'openai',
      apiKey: 'sk-deepseek-key',
      models: ['deepseek-v4-pro'],
      selectedModel: 'deepseek-v4-pro',
      isActive: true,
      healthStatus: 'healthy',
    };

    await useModelProviderStore.getState().upsertProvider(provider);

    await useModelProviderStore
      .getState()
      .removeModelFromProvider('deepseek', 'deepseek-v4-pro');

    const updated = useModelProviderStore
      .getState()
      .userProviders.find((p) => p.providerKey === 'deepseek');

    expect(updated?.models).toEqual(['deepseek-v4-pro']);
  });

  it('聚合逻辑验证：官方预设模型与用户自定义模型并集去重', () => {
    const presetModels = AI_PROVIDER_PRESETS.dashscope.models;
    const userCustomModels = ['qwen-my-finetuned-001', 'qwen3.8-max']; // 包含一个已有和一个新增

    const combined = Array.from(new Set([...presetModels, ...userCustomModels]));

    expect(combined).toContain('qwen3.8-max');
    expect(combined).toContain('qwen-my-finetuned-001');
    // 去重后数量应为 presetModels.length + 1
    expect(combined.length).toBe(presetModels.length + 1);
  });
});
