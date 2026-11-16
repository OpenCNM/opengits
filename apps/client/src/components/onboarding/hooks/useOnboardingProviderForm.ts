'use client';

import { useState, useEffect } from 'react';
import { toastManager } from '@/components/ui/toast';
import { STORAGE_KEYS, AI_PROVIDER_PRESETS } from '@/lib/constants';
import { UserModelProviderDTO } from '@/types/user-model-provider';
import { useModalStore } from '@/lib/stores/modal-store';
import { useModelProviderStore } from '@/lib/stores/model-provider-store';
import * as m from '@/paraglide/messages';

interface UseOnboardingProviderFormOptions {
  userId?: string;
  isOpen: boolean;
  onDismiss?: () => void;
  onClearTestResult?: () => void;
}

export function useOnboardingProviderForm({
  userId,
  isOpen,
  onDismiss,
  onClearTestResult,
}: UseOnboardingProviderFormOptions) {
  const modalOptions = useModalStore((s) => s.apiKeyModalOptions);
  const closeApiKeyModal = useModalStore((s) => s.closeApiKeyModal);
  const upsertProvider = useModelProviderStore((s) => s.upsertProvider);
  const dynamicProviders = useModelProviderStore((s) => s.dynamicProviders);
  const userProviders = useModelProviderStore((s) => s.userProviders);
  const loadProviders = useModelProviderStore((s) => s.loadProviders);

  const [saving, setSaving] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [provider, setProvider] = useState<string>('google');
  const [baseUrl, setBaseUrl] = useState<string>(
    'https://generativelanguage.googleapis.com/v1beta/openai'
  );
  const [apiFormat, setApiFormat] = useState<'openai' | 'anthropic'>('openai');
  const [model, setModel] = useState<string>('gemini-3.7-flash');
  const [modelList, setModelList] = useState<string[]>([
    'gemini-3.7-flash',
    'gemini-3.1-pro',
    'gemini-3.6-flash',
  ]);
  const [showAdvancedUrl, setShowAdvancedUrl] = useState(false);
  const [isAddingModel, setIsAddingModel] = useState(false);
  const [newModelName, setNewModelName] = useState('');

  // Helper to resolve combined models and settings for a given provider
  const resolveProviderModels = (key: string) => {
    const matchedUser = userProviders.find((up) => up.providerKey === key);
    const matchedDynamic = dynamicProviders.find((dp) => dp.providerKey === key);
    const preset = (AI_PROVIDER_PRESETS as any)[key];

    const baseModels: string[] = matchedDynamic?.models || preset?.models || [];
    const userCustomModels: string[] = matchedUser?.models || [];
    const combinedModels = Array.from(new Set([...baseModels, ...userCustomModels]));

    const defaultOrSelected =
      matchedUser?.selectedModel ||
      matchedDynamic?.defaultModel ||
      preset?.defaultModel ||
      combinedModels[0] ||
      '';

    const resolvedBaseUrl =
      matchedUser?.baseUrl ||
      matchedDynamic?.baseUrl ||
      preset?.baseUrl ||
      '';

    const resolvedApiFormat =
      (matchedUser?.apiFormat ||
        matchedDynamic?.apiFormat ||
        preset?.apiFormat ||
        'openai') as 'openai' | 'anthropic';

    return {
      combinedModels,
      defaultOrSelected,
      baseUrl: resolvedBaseUrl,
      apiFormat: resolvedApiFormat,
      savedApiKey: matchedUser?.apiKey || '',
    };
  };

  // Fetch dynamic providers on modal open
  useEffect(() => {
    if (isOpen) {
      loadProviders(userId);
    }
  }, [isOpen, userId, loadProviders]);

  // Sync form defaults when modal opens or dynamicProviders / userProviders load
  useEffect(() => {
    if (!isOpen) return;

    const currentActiveKey = localStorage.getItem(STORAGE_KEYS.AGENT_PROVIDER);
    const storedKey = localStorage.getItem(STORAGE_KEYS.VAR_API_KEY);

    const activeList = dynamicProviders.filter((p) => p.isEnabled !== false);
    const userActive = userProviders.find((p) => p.isActive);

    const targetKey =
      userActive?.providerKey ||
      currentActiveKey ||
      (activeList.length > 0 ? activeList[0].providerKey : 'google');

    const resolved = resolveProviderModels(targetKey);
    setProvider(targetKey);
    if (resolved.baseUrl) setBaseUrl(resolved.baseUrl);
    setApiFormat(resolved.apiFormat);
    setModelList(resolved.combinedModels);
    setModel(resolved.defaultOrSelected);

    if (storedKey) {
      setApiKey(storedKey);
    } else if (resolved.savedApiKey) {
      setApiKey(resolved.savedApiKey);
    }
  }, [isOpen, dynamicProviders, userProviders]);

  const handleProviderSelect = (key: string) => {
    setProvider(key);
    setIsAddingModel(false);
    setNewModelName('');
    if (onClearTestResult) onClearTestResult();

    const resolved = resolveProviderModels(key);
    if (resolved.baseUrl) setBaseUrl(resolved.baseUrl);
    setApiFormat(resolved.apiFormat);
    setModelList(resolved.combinedModels);
    setModel(resolved.defaultOrSelected);
    if (resolved.savedApiKey && !apiKey) {
      setApiKey(resolved.savedApiKey);
    }
  };

  const handleApiKeyChange = (val: string) => {
    setApiKey(val);
    if (onClearTestResult) onClearTestResult();
  };

  const handleAddCustomModel = (customName?: string) => {
    const raw = typeof customName === 'string' ? customName : newModelName;
    const trimmed = raw.trim();
    if (!trimmed) return;

    if (!modelList.includes(trimmed)) {
      setModelList((prev) => [...prev, trimmed]);
    }
    setModel(trimmed);
    setNewModelName('');
    setIsAddingModel(false);
    if (onClearTestResult) onClearTestResult();
  };

  const handleRemoveModel = (modelNameToRemove: string) => {
    const nextList = modelList.filter((m) => m !== modelNameToRemove);
    setModelList(nextList);
    if (model === modelNameToRemove) {
      setModel(nextList[0] || '');
    }
    if (onClearTestResult) onClearTestResult();
  };

  const handleFinish = async () => {
    if (!apiKey.trim()) {
      toastManager.add({
        title: m.provider_test_missing_key_title(),
        description: m.provider_form_api_key_custom_placeholder(),
        type: 'error',
      });
      return;
    }

    setSaving(true);
    try {
      const dynamicItem = dynamicProviders.find((p) => p.providerKey === provider);
      const presetItem = (AI_PROVIDER_PRESETS as any)[provider];
      const providerName = dynamicItem?.name || presetItem?.name || provider;
      const matchedUser = userProviders.find((up) => up.providerKey === provider);

      const modelsToSave =
        modelList.length > 0
          ? modelList.includes(model)
            ? modelList
            : [...modelList, model]
          : [model];

      const userProvider: UserModelProviderDTO = {
        id: matchedUser?.id || `prov_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        userId: userId || 'local-guest',
        providerKey: provider,
        name: providerName,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        apiFormat,
        models: modelsToSave,
        selectedModel: model,
        isActive: true,
        healthStatus: 'healthy',
        updatedAt: new Date().toISOString(),
      };

      await upsertProvider(userProvider, userId);

      toastManager.add({
        title: m.onboarding_provider_activated_title(),
        description: m.onboarding_provider_switched_desc({ name: userProvider.name, model: userProvider.selectedModel }),
        type: 'success',
      });

      closeApiKeyModal();
      if (onDismiss) onDismiss();
      if (modalOptions?.onCompleted) {
        modalOptions.onCompleted();
      }
    } catch (err) {
      toastManager.add({
        title: m.toast_save_failed(),
        description: err instanceof Error ? err.message : m.common_retry_later(),
        type: 'error',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDismiss = () => {
    closeApiKeyModal();
    if (onDismiss) onDismiss();
  };

  return {
    dynamicProviders,
    modalOptions,
    saving,
    apiKey,
    setApiKey,
    showApiKey,
    setShowApiKey,
    provider,
    baseUrl,
    setBaseUrl,
    apiFormat,
    setApiFormat,
    model,
    setModel,
    modelList,
    setModelList,
    showAdvancedUrl,
    setShowAdvancedUrl,
    isAddingModel,
    setIsAddingModel,
    newModelName,
    setNewModelName,
    handleAddCustomModel,
    handleRemoveModel,
    handleProviderSelect,
    handleApiKeyChange,
    handleFinish,
    handleDismiss,
  };
}
