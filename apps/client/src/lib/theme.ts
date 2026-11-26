import { DEFAULT_THEME, STORAGE_KEYS, THEME_OPTIONS, type ThemeOption } from '@/lib/constants';

export type { ThemeOption };

export function resolveTheme(raw: unknown): ThemeOption {
  return THEME_OPTIONS.includes(raw as ThemeOption) ? (raw as ThemeOption) : DEFAULT_THEME;
}

export function themeToColorScheme(theme: ThemeOption): 'dark' | 'light' {
  return theme === 'dark' ? 'dark' : 'light';
}

export function applyThemeToDom(theme: ThemeOption): void {
  if (typeof document === 'undefined') return;
  const next = resolveTheme(theme);
  const scheme = themeToColorScheme(next);
  const root = document.documentElement;
  const body = document.body;

  root.setAttribute('data-theme', next);
  root.style.colorScheme = scheme;

  if (next === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }

  if (body) {
    body.removeAttribute('data-theme');
    body.classList.remove('dark');
  }

  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) {
    meta.setAttribute('content', scheme);
  }

  try {
    localStorage.setItem(STORAGE_KEYS.THEME_PREFERENCE, next);
    document.cookie = `${STORAGE_KEYS.THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  } catch {
  }
}

export function buildThemeInitScript(): string {
  const prefKey = JSON.stringify(STORAGE_KEYS.THEME_PREFERENCE);
  const cookieKey = JSON.stringify(STORAGE_KEYS.THEME_COOKIE);
  const fallbackTheme = JSON.stringify(DEFAULT_THEME);
  return `(function(){try{var d=document.documentElement,k=${prefKey},c=${cookieKey},f=${fallbackTheme},s=null;try{s=localStorage.getItem(k)}catch(e){}var t=s==='dark'||(!s&&d.getAttribute('data-theme')==='dark')?'dark':f,cs=t==='dark'?'dark':'light';d.setAttribute('data-theme',t);d.classList.toggle('dark',t==='dark');d.style.colorScheme=cs;var m=document.querySelector('meta[name="color-scheme"]');if(m)m.setAttribute('content',cs);document.cookie=c+'='+t+'; path=/; max-age=31536000; samesite=lax'}catch(e){}})();`;
}

export const THEME_INIT_SCRIPT = buildThemeInitScript();
