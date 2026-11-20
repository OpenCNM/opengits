import { create } from 'zustand';
import { STORAGE_KEYS } from '@/lib/constants';
import { GlobalModelProviderDTO } from '@/types/model-provider';
import { UserModelProviderDTO } from '@/types/user-model-provider';
import { mergeCloudProviders, runtimeApiKeyToWrite } from '@/lib/model-providers-sync';
import { api, ApiClientError } from '@/lib/api/client';
import { useSettingsStore } from '@/lib/stores/settings-store';

interface ModelProviderStoreState {
  userProviders: UserModelProviderDTO[];
  dynamicProviders: GlobalModelProviderDTO[];
  isLoading: boolean;
  isInitialized: boolean;
  loadedUserId: string | null;

  // Actions
  loadProviders: (userId?: string) => Promise<void>;
  upsertProvider: (providerDTO: UserModelProviderDTO, userId?: string) => Promise<void>;
  deleteProvider: (providerKey: string, userId?: string) => Promise<void>;
  setActiveProvider: (providerKey: string, userId?: string) => Promise<void>;
  setSelectedModel: (providerKey: string, model: string, userId?: string) => Promise<void>;
  addModelToProvider: (providerKey: string, modelName: string, userId?: string) => Promise<void>;
  removeModelFromProvider: (providerKey: string, modelName: string, userId?: string) => Promise<void>;
}

export const syncActiveToRuntime = (providers: UserModelProviderDTO[]) => {
  if (typeof window === 'undefined') return;
  const active = providers.find((p) => p.isActive) || providers[0];
  const settings = useSettingsStore.getState();
  if (active) {
    const keyToWrite = runtimeApiKeyToWrite(active);
    settings.setSettings({
      provider: active.providerKey,
      providerName: active.name,
      baseUrl: active.baseUrl,
      apiFormat: active.apiFormat,
      modelsList: active.models,
      model: active.selectedModel,
      // CLEAR = 清空（空串等价于旧 removeItem：api-key-guard 以非空判定）
      ...(keyToWrite === 'CLEAR' ? { apiKey: '' } : keyToWrite !== null ? { apiKey: keyToWrite } : {}),
    });
  } else {
    settings.setSettings({ apiKey: '' });
  }
  // 订阅方（InkSpirit/DynamicVar 等）经 useSettingsStore.subscribe 自动感知，无需事件广播
};

export const useModelProviderStore = create<ModelProviderStoreState>((set, get) => ({
  userProviders: [],
  dynamicProviders: [],
  isLoading: false,
  isInitialized: false,
  loadedUserId: null,

  loadProviders: async (userId?: string) => {
    let locals: UserModelProviderDTO[] = [];
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(STORAGE_KEYS.USER_MODEL_PROVIDERS);
        if (stored) locals = JSON.parse(stored);
      } catch (e) {
        console.error('Failed to parse local providers:', e);
      }
    }

    // Optimistic initial sync from localStorage (only when unauthenticated or first mount before user load)
    if (locals.length > 0 && !userId) {
      set({ userProviders: locals });
    }

    set({ isLoading: true });

    let dyns: GlobalModelProviderDTO[] = [];
    try {
      const data = await api.get<{ fallback: boolean; providers: GlobalModelProviderDTO[] }>('/api/ai/providers', {
        onUnauthorized: 'throw',
      });
      dyns = data.providers || [];
    } catch (e) {
      if (e instanceof ApiClientError && (e.status === 401 || e.status === 403)) {
        dyns = [];
      } else {
        console.error('Failed to fetch dynamic providers:', e);
      }
    }

    let clouds: UserModelProviderDTO[] = [];
    let cloudFetchSucceeded = false;
    if (userId) {
      try {
        // 被动云同步：匿名/会话过期属预期场景（PreferencesModal 全局挂载），
        // 401/403 静默回落本地 providers，绝不允许触发登录跳转
        const data = await api.get<{ providers: UserModelProviderDTO[] }>('/api/user/model-providers', {
          onUnauthorized: 'throw',
        });
        clouds = data.providers || [];
        cloudFetchSucceeded = true;
      } catch (e) {
        if (e instanceof ApiClientError && (e.status === 401 || e.status === 403)) {
          clouds = [];
        } else {
          console.error('Failed to fetch cloud providers:', e);
        }
      }
    }

    let merged: UserModelProviderDTO[];
    if (userId && cloudFetchSucceeded) {
      // Cloud SSOT：已登录且云端拉取成功时，以云端列表为唯一权威，严禁混入未上云的 localOnly 残留；
      // 仅当云端确认 hasApiKey === true 时继承本地明文副本，否则清除本地失效明文防误判。
      const localByKey = new Map(locals.map((p) => [p.providerKey, p]));
      merged = clouds.map((c) => {
        if (!c.hasApiKey) {
          const { apiKey: _dropped, ...withoutKey } = c;
          return withoutKey;
        }
        if (c.apiKey) return c;
        const l = localByKey.get(c.providerKey);
        return l?.apiKey ? { ...c, apiKey: l.apiKey } : c;
      });
    } else {
      merged = mergeCloudProviders(clouds, locals);
    }

    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.USER_MODEL_PROVIDERS, JSON.stringify(merged));
      syncActiveToRuntime(merged);
    }

    set({
      userProviders: merged,
      dynamicProviders: dyns,
      isLoading: false,
      isInitialized: true,
      // 云同步失败 ≠ 已同步（批次 B：api-key-guard 以 isInitialized && loadedUserId
      // 判定云端 SSOT 权威态）——失败时保持 null，守卫回落本地检查，不误认云端已对账
      loadedUserId: cloudFetchSucceeded ? (userId ?? null) : null,
    });
  },

  upsertProvider: async (providerDTO: UserModelProviderDTO, userId?: string) => {
    const current = get().userProviders;
    let updatedList = [...current];
    const existIdx = updatedList.findIndex((p) => p.providerKey === providerDTO.providerKey);

    if (existIdx >= 0) {
      updatedList[existIdx] = {
        ...updatedList[existIdx],
        ...providerDTO,
        apiKey: providerDTO.apiKey || updatedList[existIdx].apiKey,
      };
    } else {
      updatedList.push(providerDTO);
    }

    if (providerDTO.isActive) {
      updatedList = updatedList.map((p) => ({
        ...p,
        isActive: p.providerKey === providerDTO.providerKey,
      }));
    }

    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.USER_MODEL_PROVIDERS, JSON.stringify(updatedList));
      syncActiveToRuntime(updatedList);
    }

    set({ userProviders: updatedList });

    if (userId) {
      try {
        await api.post('/api/user/model-providers', providerDTO);
      } catch (e) {
        // Cloud SSOT：云端落库失败必须回滚本地乐观状态并上抛，禁止"本地假成功"
        if (typeof window !== 'undefined') {
          localStorage.setItem(STORAGE_KEYS.USER_MODEL_PROVIDERS, JSON.stringify(current));
          syncActiveToRuntime(current);
        }
        set({ userProviders: current });
        console.error('Failed to sync upserted provider to cloud:', e);
        throw e;
      }
    }
  },

  deleteProvider: async (providerKey: string, userId?: string) => {
    const current = get().userProviders;
    const target = current.find((p) => p.providerKey === providerKey);
    const wasActive = target?.isActive;

    let updated = current.filter((p) => p.providerKey !== providerKey);
    if (wasActive && updated.length > 0) {
      updated = updated.map((p, idx) => ({
        ...p,
        isActive: idx === 0,
      }));
    }

    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.USER_MODEL_PROVIDERS, JSON.stringify(updated));
      syncActiveToRuntime(updated);
    }

    set({ userProviders: updated });

    if (userId) {
      try {
        await api.delete(`/api/user/model-providers?providerKey=${encodeURIComponent(providerKey)}`);
      } catch (e) {
        console.error('Failed to sync deleted provider to cloud:', e);
      }
    }
  },

  setActiveProvider: async (providerKey: string, userId?: string) => {
    const current = get().userProviders;
    const updated = current.map((p) => ({
      ...p,
      isActive: p.providerKey === providerKey,
    }));

    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.USER_MODEL_PROVIDERS, JSON.stringify(updated));
      syncActiveToRuntime(updated);
    }

    set({ userProviders: updated });

    if (userId) {
      try {
        // 服务端语义：PATCH {providerKey, makeActive} 事务内单激活切换
        //（此前误调不存在的 /active 端点，云端激活状态一直未同步成功）
        await api.patch('/api/user/model-providers', { providerKey, makeActive: true });
      } catch (e) {
        console.error('Failed to sync active provider to cloud:', e);
      }
    }
  },

  setSelectedModel: async (providerKey: string, model: string, userId?: string) => {
    const current = get().userProviders;
    const target = current.find((p) => p.providerKey === providerKey);
    if (!target) return;

    const updatedDTO: UserModelProviderDTO = {
      ...target,
      selectedModel: model,
    };

    await get().upsertProvider(updatedDTO, userId);
  },

  addModelToProvider: async (providerKey: string, modelName: string, userId?: string) => {
    const current = get().userProviders;
    const target = current.find((p) => p.providerKey === providerKey);
    if (!target) return;

    const cleanModel = modelName.trim();
    if (!cleanModel || target.models.includes(cleanModel)) return;

    const updatedDTO: UserModelProviderDTO = {
      ...target,
      models: [...target.models, cleanModel],
      selectedModel: cleanModel,
    };

    await get().upsertProvider(updatedDTO, userId);
  },

  removeModelFromProvider: async (providerKey: string, modelName: string, userId?: string) => {
    const current = get().userProviders;
    const target = current.find((p) => p.providerKey === providerKey);
    if (!target || target.models.length <= 1) return;

    const updatedModels = target.models.filter((m) => m !== modelName);
    const updatedDTO: UserModelProviderDTO = {
      ...target,
      models: updatedModels,
      selectedModel: target.selectedModel === modelName ? updatedModels[0] : target.selectedModel,
    };

    await get().upsertProvider(updatedDTO, userId);
  },
}));
