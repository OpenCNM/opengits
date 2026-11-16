'use client';

import { useState } from 'react';
import { toastManager } from '@/components/ui/toast';
import { UserModelProviderDTO } from '@/types/user-model-provider';
import { useModelProviderStore } from '@/lib/stores/model-provider-store';
import { useProviderFormStore } from '@/lib/stores/provider-form-store';
import * as m from '@/paraglide/messages';

interface UseProviderFormManagerOptions {
  userId?: string;
  onSaved?: () => void;
}

export function useProviderFormManager({ userId, onSaved }: UseProviderFormManagerOptions) {
  const userProviders = useModelProviderStore((s) => s.userProviders);
  const upsertProvider = useModelProviderStore((s) => s.upsertProvider);
  const deleteProvider = useModelProviderStore((s) => s.deleteProvider);

  const patchDraft = useProviderFormStore((s) => s.patchDraft);
  const loadPreset = useProviderFormStore((s) => s.loadPreset);

  const [saving, setSaving] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingProviderKey, setEditingProviderKey] = useState<string | null>(null);

  const resetFormWithPreset = (presetKey: string) => {
    loadPreset({ providerKey: presetKey });
  };

  const handleOpenAddForm = () => {
    setEditingProviderKey(null);
    setIsFormOpen(true);
    resetFormWithPreset('google');
  };

  const handleEditProvider = (p: UserModelProviderDTO) => {
    setEditingProviderKey(p.providerKey);
    patchDraft({
      formProviderKey: p.providerKey,
      formName: p.name,
      formBaseUrl: p.baseUrl,
      formApiFormat: p.apiFormat,
      formApiKey: '',
      formModels: [...p.models],
      formSelectedModel: p.selectedModel,
      formIsActive: p.isActive,
      showApiKey: false,
    });
    setIsFormOpen(true);
  };

  const handleDeleteProvider = async (providerKey: string) => {
    const target = userProviders.find((p) => p.providerKey === providerKey);
    const wasActive = target?.isActive;

    await deleteProvider(providerKey, userId);

    toastManager.add({
      title: m.preferences_provider_removed_title(),
      description: wasActive && userProviders.length > 1 ? m.preferences_provider_updated() : m.preferences_provider_cleared(),
      type: 'info',
    });

    if (userProviders.length <= 1) {
      setIsFormOpen(true);
      resetFormWithPreset('google');
    }
  };

  const handleSaveForm = async () => {
    const {
      formProviderKey,
      formName,
      formBaseUrl,
      formApiKey,
      formApiFormat,
      formModels,
      formSelectedModel,
      formIsActive,
    } = useProviderFormStore.getState();

    const isEditingExisting = Boolean(
      editingProviderKey && userProviders.some((p) => p.providerKey === editingProviderKey)
    );

    if (!formApiKey.trim() && !isEditingExisting) {
      toastManager.add({
        title: m.provider_test_missing_key_title(),
        description: m.preferences_missing_key_desc(),
        type: 'error',
      });
      return;
    }

    setSaving(true);
    try {
      const finalKey = formProviderKey === 'custom' ? `custom-${Date.now()}` : formProviderKey;
      const existing = userProviders.find((p) => p.providerKey === (editingProviderKey || finalKey));

      const newDTO: UserModelProviderDTO = {
        id: existing?.id || `local-${editingProviderKey || finalKey}`,
        providerKey: editingProviderKey || finalKey,
        name: formName.trim() || m.provider_custom_name(),
        baseUrl: formBaseUrl.trim(),
        apiKey: formApiKey.trim() || existing?.apiKey || '',
        apiFormat: formApiFormat,
        models: formModels.length > 0 ? formModels : [formSelectedModel.trim() || 'default'],
        selectedModel: formSelectedModel.trim() || formModels[0] || 'default',
        isActive: formIsActive || userProviders.length === 0,
        healthStatus: existing?.healthStatus || 'unknown',
      };

      await upsertProvider(newDTO, userId);

      toastManager.add({
        title: m.provider_saved_title(),
        description: m.provider_configured_desc({ name: newDTO.name }),
        type: 'success',
      });

      setIsFormOpen(false);
      setEditingProviderKey(null);
      if (onSaved) onSaved();
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

  return {
    isFormOpen,
    setIsFormOpen,
    editingProviderKey,
    setEditingProviderKey,
    saving,
    resetFormWithPreset,
    handleOpenAddForm,
    handleEditProvider,
    handleDeleteProvider,
    handleSaveForm,
  };
}
