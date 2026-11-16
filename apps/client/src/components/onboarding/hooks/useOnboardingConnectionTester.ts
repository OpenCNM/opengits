'use client';

import { useState } from 'react';
import { toastManager } from '@/components/ui/toast';
import * as m from '@/paraglide/messages';
import { resolveProviderTestErrorMessage } from '@/lib/i18n/provider-test-errors';

interface UseOnboardingConnectionTesterOptions {
  provider: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: 'openai' | 'anthropic';
  model: string;
}

export function useOnboardingConnectionTester({
  provider,
  baseUrl,
  apiKey,
  apiFormat,
  model,
}: UseOnboardingConnectionTesterOptions) {
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleTestConnection = async () => {
    if (!apiKey.trim()) {
      toastManager.add({
        title: m.provider_test_missing_key_title(),
        description: m.provider_test_missing_key_desc(),
        type: 'error',
      });
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    try {
      const res = await fetch('/api/ai/test-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          providerKey: provider,
          baseUrl,
          apiKey: apiKey.trim(),
          apiFormat,
          model,
        }),
      });

      const data = await res.json();
      const payload = data?.data;
      if (res.ok && data.success && payload) {
        setTestResult({
          success: true,
          message: m.provider_test_connected({ latency: payload.latencyMs ?? 0 }),
        });
      } else {
        setTestResult({
          success: false,
          message: resolveProviderTestErrorMessage(data?.code, data?.error),
        });
      }
    } catch (err) {
      setTestResult({
        success: false,
        message: m.provider_test_timeout_title(),
      });
    } finally {
      setIsTesting(false);
    }
  };

  return {
    isTesting,
    testResult,
    setTestResult,
    handleTestConnection,
  };
}
