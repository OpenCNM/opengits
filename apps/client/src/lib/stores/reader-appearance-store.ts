import { create } from 'zustand';
import {
  DEFAULT_THEME,
  STORAGE_KEYS,
  DEFAULT_FONT_SIZE,
  type FontSizeOption,
  type ThemeOption,
} from '@/lib/constants';
import { applyFontSize, resolveFontSize } from '@/lib/font-size';
import { applyThemeToDom, resolveTheme } from '@/lib/theme';

export type { ThemeOption };
export { applyThemeToDom, resolveTheme };

interface ReaderAppearanceState {
  theme: ThemeOption;
  fontSize: FontSizeOption;

  setTheme: (theme: ThemeOption) => void;
  setFontSize: (size: FontSizeOption) => void;
  initAppearance: (userFontSize?: string | null) => void;
}

export const useReaderAppearanceStore = create<ReaderAppearanceState>((set) => ({
  theme: DEFAULT_THEME,
  fontSize: DEFAULT_FONT_SIZE,

  setTheme: (theme: ThemeOption) => {
    const resolved = resolveTheme(theme);
    applyThemeToDom(resolved);
    set({ theme: resolved });
  },

  setFontSize: (size: FontSizeOption) => {
    const resolved = resolveFontSize(size);
    applyFontSize(resolved);
    set({ fontSize: resolved });
  },

  initAppearance: (userFontSize?: string | null) => {
    if (typeof window === 'undefined') return;

    let rawTheme: string | null = null;
    try {
      rawTheme = localStorage.getItem(STORAGE_KEYS.THEME_PREFERENCE);
    } catch {
    }
    const resolvedTheme = resolveTheme(rawTheme || document.documentElement.getAttribute('data-theme'));
    applyThemeToDom(resolvedTheme);

    let storedSize: string | null = null;
    try {
      storedSize = localStorage.getItem(STORAGE_KEYS.FONT_SIZE);
    } catch {
    }
    const rawSize = userFontSize || storedSize;
    const resolvedSize = resolveFontSize(rawSize);
    applyFontSize(resolvedSize);

    set({
      theme: resolvedTheme,
      fontSize: resolvedSize,
    });
  },
}));

