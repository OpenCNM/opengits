import { create } from 'zustand';
import { STORAGE_KEYS, DEFAULT_FONT_SIZE, type FontSizeOption } from '@/lib/constants';
import { applyFontSize, resolveFontSize } from '@/lib/font-size';

export type ThemeOption = 'vercel' | 'dark';

interface ReaderAppearanceState {
  theme: ThemeOption;
  fontSize: FontSizeOption;

  // Actions
  setTheme: (theme: ThemeOption) => void;
  setFontSize: (size: FontSizeOption) => void;
  initAppearance: (userFontSize?: string | null) => void;
}

export function applyThemeToDom(theme: ThemeOption): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const body = document.body;

  root.setAttribute('data-theme', theme);
  if (body) body.setAttribute('data-theme', theme);

  if (theme === 'dark') {
    root.classList.add('dark');
    if (body) body.classList.add('dark');
  } else {
    root.classList.remove('dark');
    if (body) body.classList.remove('dark');
  }

  try {
    localStorage.setItem(STORAGE_KEYS.THEME_PREFERENCE, theme);
  } catch {}
}

export const useReaderAppearanceStore = create<ReaderAppearanceState>((set, get) => ({
  theme: 'vercel',
  fontSize: DEFAULT_FONT_SIZE,

  setTheme: (theme: ThemeOption) => {
    applyThemeToDom(theme);
    set({ theme });
  },

  setFontSize: (size: FontSizeOption) => {
    const resolved = resolveFontSize(size);
    applyFontSize(resolved);
    set({ fontSize: resolved });
  },

  initAppearance: (userFontSize?: string | null) => {
    if (typeof window === 'undefined') return;

    // 1. Theme
    const rawTheme = localStorage.getItem(STORAGE_KEYS.THEME_PREFERENCE);
    const resolvedTheme: ThemeOption = rawTheme === 'dark' ? 'dark' : 'vercel';
    applyThemeToDom(resolvedTheme);

    // 2. Font Size
    const rawSize = userFontSize || localStorage.getItem(STORAGE_KEYS.FONT_SIZE);
    const resolvedSize = resolveFontSize(rawSize);
    applyFontSize(resolvedSize);

    set({
      theme: resolvedTheme,
      fontSize: resolvedSize,
    });
  },
}));

