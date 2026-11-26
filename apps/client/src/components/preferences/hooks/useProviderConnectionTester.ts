'use client';

import { useState } from 'react';
import { toastManager } from '@/components/ui/toast';
import type { UserModelProviderDTO } from '@/types/user-model-provider';
import { useProviderFormStore } from '@/lib/stores/provider-form-store';
import * as m from '@/paraglide/messages';
import { resolveProviderTestErrorMessage } from '@/lib/i18n/provider-test-errors';

export function useProviderConnectionTester(
  userProviders: UserModelProviderDTO[] = [],
  editingProviderKey: string | null = null
) {
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    key: string;
    success: boolean;
    message: string;
    latencyMs?: number;
  } | null>(null);

  const handleTestProvider = async (p: UserModelProviderDTO) => {
    setTestingKey(p.providerKey);
    setTestResult(null);

    try {
      const res = await fetch('/api/ai/test-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: p.providerKey,
          providerKey: p.providerKey,
          baseUrl: p.baseUrl,
          apiKey: p.apiKey || '',
          apiFormat: p.apiFormat,
          model: p.selectedModel,
        }),
      });

      const data = await res.json();
      const payload = data?.data;
      if (res.ok && data.success && payload) {
        setTestResult({
          key: p.providerKey,
          success: true,
          message: m.provider_test_connected({ latency: payload.latencyMs ?? 0 }),
          latencyMs: payload.latencyMs,
        });
        toastManager.add({
          title: m.provider_test_success_title(),
          description: m.provider_test_success_desc({ name: p.name, latency: payload.latencyMs ?? 0 }),
          type: 'success',
        });
      } else {
        const errMessage = resolveProviderTestErrorMessage(data?.code, data?.error);
        setTestResult({
          key: p.providerKey,
          success: false,
          message: errMessage,
        });
        toastManager.add({
          title: m.provider_test_failed_title(),
          description: errMessage,
          type: 'error',
        });
      }
    } catch (err) {
      setTestResult({
        key: p.providerKey,
        success: false,
        message: m.provider_test_timeout_title(),
      });
    } finally {
      setTestingKey(null);
    }
  };

  const handleTestFormValues = async () => {
    const {
      formProviderKey,
      formName,
      formBaseUrl,
      formApiKey,
      formApiFormat,
      formModels,
      formSelectedModel,
    } = useProviderFormStore.getState();
    const isEditingExisting = Boolean(
      editingProviderKey && userProviders.some((p) => p.providerKey === editingProviderKey)
    );
    if (!formApiKey.trim() && !isEditingExisting) {
      toastManager.add({
        title: m.provider_test_missing_key_title(),
        description: m.provider_test_missing_key_desc(),
        type: 'error',
      });
      return;
    }

    const modelToTest = formSelectedModel.trim() || (formModels.length > 0 ? formModels[0] : '');
    if (!modelToTest) {
      toastManager.add({
        title: m.provider_test_missing_model_title(),
        description: m.provider_test_missing_model_desc(),
        type: 'error',
      });
      return;
    }

    setTestingKey('__form__');
    try {
      const res = await fetch('/api/ai/test-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: formProviderKey,
          providerKey: formProviderKey,
          baseUrl: formBaseUrl,
          apiKey: formApiKey.trim(),
          apiFormat: formApiFormat,
          model: modelToTest,
        }),
      });

      const data = await res.json();
      const payload = data?.data;
      if (res.ok && data.success && payload) {
        toastManager.add({
          title: m.provider_test_success_title(),
          description: m.provider_test_success_desc({ name: formName, latency: payload.latencyMs ?? 0 }),
          type: 'success',
        });
      } else {
        toastManager.add({
          title: m.provider_test_failed_title(),
          description: resolveProviderTestErrorMessage(data?.code, data?.error),
          type: 'error',
        });
      }
    } catch (err) {
      toastManager.add({
        title: m.provider_test_timeout_title(),
        description: m.provider_test_check_network(),
        type: 'error',
      });
    } finally {
      setTestingKey(null);
    }
  };

  return {
    testingKey,
    testResult,
    handleTestProvider,
    handleTestFormValues,
  };
}
