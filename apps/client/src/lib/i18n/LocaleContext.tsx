'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { ignoreBestEffort } from '@/lib/best-effort';
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

export function resolveSupportedLocale(rawLocale?: string | null): string {
  if (!rawLocale || typeof rawLocale !== 'string') {
    return 'en';
  }
  const trimmed = rawLocale.trim();
  const exact = SUPPORTED_LOCALES.find((l) => l.code.toLowerCase() === trimmed.toLowerCase());
  if (exact) return exact.code;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('zh')) {
    return 'zh-CN';
  }
  if (lower.startsWith('en')) {
    return 'en';
  }

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

  try {
    setParaglideLocale(locale as any, { reload: false });
  } catch {
    ignoreBestEffort();
  }

  useEffect(() => {
    try {
      const current = getLocale();
      const resolved = resolveSupportedLocale(current);
      if (resolved && resolved !== locale) {
        setLocaleState(resolved);
      }
    } catch {
      ignoreBestEffort();
    }

    const handleLocaleChange = (e: CustomEvent<string>) => {
      if (e.detail) {
        const resolved = resolveSupportedLocale(e.detail);
        setLocaleState(resolved);
        try {
          setParaglideLocale(resolved as any, { reload: false });
        } catch { ignoreBestEffort(); }
      }
    };

    window.addEventListener('locale-changed' as any, handleLocaleChange);
    return () => {
      window.removeEventListener('locale-changed' as any, handleLocaleChange);
    };
  }, [locale]);

  const changeLocale = useCallback((newLocale: string) => {
    const targetLocale = resolveSupportedLocale(newLocale);

    setLocaleState(targetLocale);

    try {
      setParaglideLocale(targetLocale as any, { reload: false });
    } catch { ignoreBestEffort(); }

    if (typeof document !== 'undefined') {
      document.cookie = `PARAGLIDE_LOCALE=${targetLocale}; path=/; max-age=31536000; SameSite=Lax`;
      document.cookie = `NEXT_LOCALE=${targetLocale}; path=/; max-age=31536000; SameSite=Lax`;
    }

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEYS.PARAGLIDE_LOCALE, targetLocale);
        localStorage.setItem(STORAGE_KEYS.NEXT_LOCALE, targetLocale);
      } catch {}
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('locale-changed', { detail: targetLocale }));
    }
  }, []);

  return (
    <LocaleContext.Provider value={{ locale, setLocale: changeLocale, locales: SUPPORTED_LOCALES }}>
      <div className="contents">
        {children}
      </div>
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  return useContext(LocaleContext);
}
