'use client';

import { STORAGE_KEYS } from '@/lib/constants';
import { useModalStore } from '@/lib/stores/modal-store';
import { useModelProviderStore } from '@/lib/stores/model-provider-store';

/**
 * 检查当前浏览器客户端是否已配置有效的 AI 服务商 API Key
 */
export function hasConfiguredApiKey(): boolean {
  if (typeof window === 'undefined') return false;

  // 1. 检查经典单一 Key
  const singleKey = localStorage.getItem(STORAGE_KEYS.VAR_API_KEY);
  if (singleKey && singleKey.trim().length > 0) {
    return true;
  }

  // 2. 检查 Zustand Store 内存态
  try {
    const storeProviders = useModelProviderStore.getState().userProviders;
    if (storeProviders && storeProviders.length > 0) {
      const active = storeProviders.find((p) => p.isActive && p.apiKey && p.apiKey.trim().length > 0);
      if (active) return true;
      const anyValid = storeProviders.some((p) => p.apiKey && p.apiKey.trim().length > 0);
      if (anyValid) return true;
    }
  } catch {
    // 容错降级: 内存 store 读取异常视为未配置，引导用户经弹窗重配
  }

  // 3. 检查多服务商矩阵 (LocalStorage)
  const rawProviders = localStorage.getItem(STORAGE_KEYS.USER_MODEL_PROVIDERS);
  if (rawProviders) {
    try {
      const list = JSON.parse(rawProviders);
      if (Array.isArray(list)) {
        // 优先检查激活项，若无激活项则检查是否存在任一有有效 Key 的配置
        const active = list.find((p: any) => p.isActive && p.apiKey && String(p.apiKey).trim().length > 0);
        if (active) return true;
        const anyValid = list.some((p: any) => p.apiKey && String(p.apiKey).trim().length > 0);
        if (anyValid) return true;
      }
    } catch {
      // 容错降级: 本地多服务商配置 JSON 损坏视为未配置，引导用户经弹窗重配
    }
  }

  return false;
}

/**
 * API Key 守卫拦截器：
 * - 若已配置 API Key，直接同步执行 onSuccess 并返回 true；
 * - 若未配置 API Key，唤起配置弹窗并注入 onSuccess 延续回调，返回 false。
 */
export function requireApiKey(onSuccess: () => void, contextText?: string): boolean {
  if (hasConfiguredApiKey()) {
    onSuccess();
    return true;
  }

  const promptText = contextText || '配置 API Key 后将自动继续解析该开源仓库';
  useModalStore.getState().openApiKeyModal({
    contextText: promptText,
    onCompleted: onSuccess,
  });

  return false;
}
