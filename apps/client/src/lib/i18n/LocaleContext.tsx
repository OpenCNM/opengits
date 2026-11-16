'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { getLocale, setLocale as setParaglideLocale } from '@/paraglide/runtime.js';
import { STORAGE_KEYS } from '@/lib/constants';

export interface LocaleOption {
  code: string;
  name: string;
  nativeName: string;
}

export const SUPPORTED_LOCALES: LocaleOption[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'zh-CN', name: 'Simplified Chinese', nativeName: '简体中文' },
];

/**
 * 语言标签宽容解析与方言归一化（zh* -> zh-CN, en* -> en）
 */
export function resolveSupportedLocale(rawLocale?: string | null): string {
  if (!rawLocale || typeof rawLocale !== 'string') {
    return 'en';
  }
  const trimmed = rawLocale.trim();
  // 1. 严格匹配
  const exact = SUPPORTED_LOCALES.find((l) => l.code.toLowerCase() === trimmed.toLowerCase());
  if (exact) return exact.code;

  // 2. 方言与前缀模糊归一化（如 zh-TW, zh-HK, zh-Hans 归一到 zh-CN；en-US, en-GB 归一到 en）
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('zh')) {
    return 'zh-CN';
  }
  if (lower.startsWith('en')) {
    return 'en';
  }

  // 3. 兜底回退
  return 'en';
}

interface LocaleContextType {
  locale: string;
  setLocale: (locale: string) => void;
  locales: LocaleOption[];
}

const LocaleContext = createContext<LocaleContextType>({
  locale: 'en',
  setLocale: () => {},
  locales: SUPPORTED_LOCALES,
});

export function LocaleProvider({ children, initialLocale = 'en' }: { children: ReactNode; initialLocale?: string }) {
  const [locale, setLocaleState] = useState<string>(() => resolveSupportedLocale(initialLocale));

  // Synchronously set Paraglide locale in the module graph on render
  try {
    setParaglideLocale(locale as any, { reload: false });
  } catch {
    // ignore
  }

  useEffect(() => {
    try {
      const current = getLocale();
      const resolved = resolveSupportedLocale(current);
      if (resolved && resolved !== locale) {
        setLocaleState(resolved);
      }
    } catch {
      // default fallback
    }

    const handleLocaleChange = (e: CustomEvent<string>) => {
      if (e.detail) {
        const resolved = resolveSupportedLocale(e.detail);
        setLocaleState(resolved);
        try {
          setParaglideLocale(resolved as any, { reload: false });
        } catch {}
      }
    };

    window.addEventListener('locale-changed' as any, handleLocaleChange);
    return () => {
      window.removeEventListener('locale-changed' as any, handleLocaleChange);
    };
  }, [locale]);

  const changeLocale = useCallback((newLocale: string) => {
    const targetLocale = resolveSupportedLocale(newLocale);
    
    // 1. Update React state immediately
    setLocaleState(targetLocale);

    // 2. Update Paraglide global variable synchronously
    try {
      setParaglideLocale(targetLocale as any, { reload: false });
    } catch {}

    // 3. Persist to Cookies for Server Components / SSR
    if (typeof document !== 'undefined') {
      document.cookie = `PARAGLIDE_LOCALE=${targetLocale}; path=/; max-age=31536000; SameSite=Lax`;
      document.cookie = `NEXT_LOCALE=${targetLocale}; path=/; max-age=31536000; SameSite=Lax`;
    }

    // 4. Persist to localStorage
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEYS.PARAGLIDE_LOCALE, targetLocale);
        localStorage.setItem(STORAGE_KEYS.NEXT_LOCALE, targetLocale);
      } catch {}
    }

    // 5. Broadcast to any other listeners on the page
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('locale-changed', { detail: targetLocale }));
    }
  }, []);

  return (
    <LocaleContext.Provider value={{ locale, setLocale: changeLocale, locales: SUPPORTED_LOCALES }}>
      {/* Decoupled from destructive unmount key to allow in-place reactive text morphing */}
      <div className="contents">
        {children}
      </div>
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  return useContext(LocaleContext);
}
