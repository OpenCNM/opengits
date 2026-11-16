'use client';

import { useEffect } from 'react';
import { useSafeSession } from '@/lib/useSafeSession';
import { useReaderAppearanceStore } from '@/lib/stores/reader-appearance-store';
import { api, ApiClientError } from '@/lib/api/client';

export default function FontSizeProvider() {
  const { data: session, status } = useSafeSession();
  const initAppearance = useReaderAppearanceStore((s) => s.initAppearance);
  const setFontSize = useReaderAppearanceStore((s) => s.setFontSize);

  useEffect(() => {
    async function loadUserPreference() {
      try {
        // 被动读取：会话过期时不弹登录跳转（否则匿名访客会被带离当前页）
        const data = await api.get<{ fontSize?: 'small' | 'medium' | 'large' }>('/api/user/preferences', {
          onUnauthorized: 'throw',
        });
        if (data.fontSize) {
          setFontSize(data.fontSize);
          return;
        }
      } catch (err) {
        // 401/403 = 未登录/会话过期，属预期静默场景；仅记录非预期错误
        if (!(err instanceof ApiClientError && (err.status === 401 || err.status === 403))) {
          console.error('Failed to load user font size preference', err);
        }
      }
      initAppearance();
    }

    if (status === 'loading') return;

    if (session) {
      loadUserPreference();
    } else {
      initAppearance();
    }
  }, [session, status, initAppearance, setFontSize]);

  return null;
}
