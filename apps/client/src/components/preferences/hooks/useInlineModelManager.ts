'use client';

import { useState } from 'react';
import { toastManager } from '@/components/ui/toast';
import { useModelProviderStore } from '@/lib/stores/model-provider-store';
import * as m from '@/paraglide/messages';

export function useInlineModelManager(userId?: string) {
  const userProviders = useModelProviderStore((s) => s.userProviders);
  const setActiveProvider = useModelProviderStore((s) => s.setActiveProvider);
  const setSelectedModel = useModelProviderStore((s) => s.setSelectedModel);
  const addModelToProvider = useModelProviderStore((s) => s.addModelToProvider);
  const removeModelFromProvider = useModelProviderStore((s) => s.removeModelFromProvider);

  const [openModelSelectorKey, setOpenModelSelectorKey] = useState<string | null>(null);
  const [inlineAddingModelKey, setInlineAddingModelKey] = useState<string | null>(null);
  const [inlineNewModelName, setInlineNewModelName] = useState('');

  const handleSetActiveProvider = async (providerKey: string) => {
    await setActiveProvider(providerKey, userId);
    const active = userProviders.find((p) => p.providerKey === providerKey);
    toastManager.add({
      title: m.preferences_provider_switched_title(),
      description: m.preferences_provider_switched_desc({ model: active?.selectedModel || '' }),
      type: 'success',
    });
  };

  const handleSelectModelInProvider = async (providerKey: string, modelName: string) => {
    await setSelectedModel(providerKey, modelName, userId);
    setOpenModelSelectorKey(null);
  };

  const handleAddInlineModel = async (providerKey: string) => {
    if (!inlineNewModelName.trim()) return;
    await addModelToProvider(providerKey, inlineNewModelName.trim(), userId);
    setInlineNewModelName('');
    setInlineAddingModelKey(null);
  };

  const handleRemoveInlineModel = async (providerKey: string, modelName: string) => {
    await removeModelFromProvider(providerKey, modelName, userId);
  };

  return {
    openModelSelectorKey,
    setOpenModelSelectorKey,
    inlineAddingModelKey,
    setInlineAddingModelKey,
    inlineNewModelName,
    setInlineNewModelName,
    handleSetActiveProvider,
    handleSelectModelInProvider,
    handleAddInlineModel,
    handleRemoveInlineModel,
  };
}
