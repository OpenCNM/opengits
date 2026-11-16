'use client';

import { useEffect } from 'react';
import { useReaderAppearanceStore } from '@/lib/stores/reader-appearance-store';

export function ThemeInitializer() {
  const initAppearance = useReaderAppearanceStore((s) => s.initAppearance);

  useEffect(() => {
    initAppearance();
  }, [initAppearance]);

  return null;
}
