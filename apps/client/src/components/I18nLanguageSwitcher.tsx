'use client';
import * as m from '@/paraglide/messages';

import React, { useState, useRef, useEffect } from 'react';
import { Languages, Check } from 'lucide-react';
import { useLocale, SUPPORTED_LOCALES } from '@/lib/i18n/LocaleContext';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipTrigger, TooltipPopup } from '@/components/ui/tooltip';

export interface I18nLanguageSwitcherProps {
  variant?: 'icon-hover' | 'ghost';
  className?: string;
}

export function I18nLanguageSwitcher({ variant = 'icon-hover', className }: I18nLanguageSwitcherProps = {}) {
  const { locale, setLocale } = useLocale();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const activeLocaleObj = SUPPORTED_LOCALES.find((l) => l.code === locale) || SUPPORTED_LOCALES[0];

  // Click outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleSelectLocale = (code: string) => {
    setIsOpen(false);
    setLocale(code);
  };

  return (
    <div ref={containerRef} className={cn('relative inline-block', className)}>
      <Tooltip>
        <TooltipTrigger
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          aria-label={m.language_interface()}
          aria-expanded={isOpen}
          className={cn(
            variant === 'ghost'
              ? 'size-8 rounded-lg hover:bg-theme-surface flex items-center justify-center text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer focus:outline-none'
              : 'size-8 rounded-full bg-theme-surface border border-theme-border/70 hover:border-theme-border flex items-center justify-center text-theme-foreground/80 hover:text-theme-foreground shadow-2xs hover:shadow-xs transition-all cursor-pointer focus:outline-none'
          )}
        >
          <Languages className={variant === 'ghost' ? 'size-4 text-theme-muted hover:text-theme-foreground' : 'size-4 text-theme-primary'} />
        </TooltipTrigger>
        {!isOpen && (
          <TooltipPopup side="bottom" align="center" className="bg-theme-surface text-theme-foreground border border-theme-border font-sans text-xs px-2.5 py-1 rounded-lg shadow-sm z-50">
            {`${m.language_interface()}: ${activeLocaleObj.nativeName}`}
          </TooltipPopup>
        )}
      </Tooltip>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-44 p-1 bg-theme-surface border border-theme-border/80 rounded-xl shadow-xl z-50 font-sans text-xs animate-in fade-in zoom-in-95 duration-100">
          <div className="px-2.5 py-1.5 text-xs font-mono font-bold text-theme-muted uppercase tracking-wider border-b border-theme-border/40 mb-1 flex items-center justify-between">
            <span>{m.language_interface()}</span>
            <Languages className="size-3 text-theme-primary" />
          </div>

          <div className="flex flex-col gap-0.5 max-h-72 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {SUPPORTED_LOCALES.map((loc) => {
              const isSelected = loc.code === locale;
              return (
                <button
                  key={loc.code}
                  type="button"
                  onClick={() => handleSelectLocale(loc.code)}
                  className={cn(
                    'w-full px-2.5 py-1.5 rounded-lg text-left flex items-center justify-between transition-colors cursor-pointer select-none text-xs',
                    isSelected
                      ? 'bg-theme-primary/10 text-theme-primary font-bold'
                      : 'text-theme-foreground hover:bg-theme-bg/60'
                  )}
                >
                  <span className="truncate">{loc.nativeName}</span>
                  {isSelected && <Check className="size-3.5 text-theme-primary shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
