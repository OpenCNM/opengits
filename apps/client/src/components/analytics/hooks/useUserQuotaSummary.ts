'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api/client';
import type { UsageSummary } from '../utils/tokenFormatters';

export function useUserQuotaSummary() {
  const [quota, setQuota] = useState<UsageSummary | null>(null);
  const [loadingQuota, setLoadingQuota] = useState(true);

  useEffect(() => {
    let isMounted = true;
    api
      .get<UsageSummary>('/api/usage/summary', { onUnauthorized: 'throw' })
      .then((j) => {
        if (isMounted) setQuota(j);
      })
      .catch(() => {})
      .finally(() => {
        if (isMounted) setLoadingQuota(false);
      });
    return () => {
      isMounted = false;
    };
  }, []);

  return {
    quota,
    loadingQuota,
  };
}
