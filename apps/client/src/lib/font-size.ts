import { DEFAULT_FONT_SIZE, FONT_SIZE_OPTIONS, STORAGE_KEYS, type FontSizeOption } from '@/lib/constants';

export function resolveFontSize(raw: unknown): FontSizeOption {
  return FONT_SIZE_OPTIONS.includes(raw as FontSizeOption) ? (raw as FontSizeOption) : DEFAULT_FONT_SIZE;
}

export function applyFontSize(size: FontSizeOption): void {
  if (typeof document === 'undefined') return;
  const next = resolveFontSize(size);
  const html = document.documentElement;
  html.classList.remove(...FONT_SIZE_OPTIONS.map((s) => `font-size-${s}`));
  html.classList.add(`font-size-${next}`);
  try {
    localStorage.setItem(STORAGE_KEYS.FONT_SIZE, next);
    document.cookie = `${STORAGE_KEYS.FONT_SIZE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  } catch {  }
}
