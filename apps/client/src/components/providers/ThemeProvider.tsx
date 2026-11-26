'use client';

import { useEffect } from 'react';
import { STORAGE_KEYS } from '@/lib/constants';
import { useReaderAppearanceStore } from '@/lib/stores/reader-appearance-store';
import { resolveTheme } from '@/lib/theme';

export function ThemeInitializer() {
  const initAppearance = useReaderAppearanceStore((s) => s.initAppearance);
  const setTheme = useReaderAppearanceStore((s) => s.setTheme);

  useEffect(() => {
    initAppearance();
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.THEME_PREFERENCE) {
        setTheme(resolveTheme(e.newValue));
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [initAppearance, setTheme]);

  return null;
}
