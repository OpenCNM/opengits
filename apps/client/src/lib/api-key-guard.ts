'use client';

import { ignoreBestEffort } from '@/lib/best-effort';
import { STORAGE_KEYS } from '@/lib/constants';
import { useModalStore } from '@/lib/stores/modal-store';
import { useModelProviderStore } from '@/lib/stores/model-provider-store';

export function hasConfiguredApiKey(): boolean {
  if (typeof window === 'undefined') return false;

  const hasProviderKey = (p: { hasApiKey?: boolean; apiKey?: string | null } | null | undefined) =>
    Boolean(p?.hasApiKey || (p?.apiKey && String(p.apiKey).trim().length > 0));

  try {
    const storeState = useModelProviderStore.getState();
    if (storeState.isInitialized && storeState.loadedUserId) {
      return storeState.userProviders.some(hasProviderKey);
    }
  } catch {
    ignoreBestEffort();
  }

  const singleKey = localStorage.getItem(STORAGE_KEYS.VAR_API_KEY);
  if (singleKey && singleKey.trim().length > 0) {
    return true;
  }

  try {
    const storeProviders = useModelProviderStore.getState().userProviders;
    if (storeProviders && storeProviders.length > 0) {
      const active = storeProviders.find((p) => p.isActive && hasProviderKey(p));
      if (active) return true;
      const anyValid = storeProviders.some(hasProviderKey);
      if (anyValid) return true;
    }
  } catch {
    ignoreBestEffort();
  }

  const rawProviders = localStorage.getItem(STORAGE_KEYS.USER_MODEL_PROVIDERS);
  if (rawProviders) {
    try {
      const list = JSON.parse(rawProviders);
      if (Array.isArray(list)) {
        const active = list.find((p: any) => p?.isActive && hasProviderKey(p));
        if (active) return true;
        const anyValid = list.some(hasProviderKey);
        if (anyValid) return true;
      }
    } catch {
    }
  }

  return false;
}

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
