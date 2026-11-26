'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api/client';
import type { UsageStatisticsResult } from '@/lib/analytics/token-usage';

export function useUsageStats(initialTimeRange: '7d' | '30d' = '30d') {
  const [timeRange, setTimeRange] = useState<'7d' | '30d'>(initialTimeRange);
  const [data, setData] = useState<UsageStatisticsResult | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchStats = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const stats = await api.get<UsageStatisticsResult>(
        `/api/analytics/usage?timeRange=${timeRange}`,
        { onUnauthorized: 'throw' }
      );
      setData(stats);
    } catch (err) {
      console.error('Error fetching usage stats:', err);
      setError(err instanceof Error ? err : new Error('Unknown error'));
    } finally {
      setIsLoading(false);
    }
  }, [timeRange]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return {
    timeRange,
    setTimeRange,
    data,
    isLoading,
    error,
    refresh: fetchStats,
  };
}
