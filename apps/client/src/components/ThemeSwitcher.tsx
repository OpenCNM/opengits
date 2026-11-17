'use client';

import React, { useEffect, useState, useRef } from 'react';
import { Moon, Sun, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { STORAGE_KEYS } from '@/lib/constants';
import * as m from '@/paraglide/messages';

import { useReaderAppearanceStore, type ThemeOption } from '@/lib/stores/reader-appearance-store';

export type { ThemeOption };

export interface ThemeSwitcherProps {
  variant?: 'pill' | 'select' | 'minimal' | 'icon-hover' | 'sidebar-pill' | 'ghost';
  className?: string;
}

export function ThemeSwitcher({ variant = 'icon-hover', className }: ThemeSwitcherProps) {
  const currentTheme = useReaderAppearanceStore((s) => s.theme);
  const setTheme = useReaderAppearanceStore((s) => s.setTheme);
  const initAppearance = useReaderAppearanceStore((s) => s.initAppearance);

  const [mounted, setMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
    initAppearance();
  }, [initAppearance]);

  // Listen for click outside to auto close popover
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleSelectTheme = (theme: ThemeOption) => {
    setTheme(theme);
    setIsOpen(false);
  };

  if (variant === 'ghost') {
    const isDark = mounted && currentTheme === 'dark';

    const handleToggle = () => {
      const nextTheme: ThemeOption = isDark ? 'vercel' : 'dark';
      handleSelectTheme(nextTheme);
    };

    return (
      <div 
        ref={containerRef}
        className={cn("relative inline-block", className)}
      >
        <button
          type="button"
          onClick={handleToggle}
          aria-label={m.theme_switch()}
          title={isDark ? m.theme_current_dark() : m.theme_current_light()}
          className="size-8 rounded-lg hover:bg-theme-surface flex items-center justify-center text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer focus:outline-none"
        >
          {isDark ? (
            <Moon className="size-4 text-sky-400 transition-transform duration-200 hover:scale-110" />
          ) : (
            <Sun className="size-4 text-amber-500 transition-transform duration-200 hover:scale-110" />
          )}
        </button>
      </div>
    );
  }

  if (variant === 'icon-hover') {
    const isDark = mounted && currentTheme === 'dark';

    const handleToggle = () => {
      const nextTheme: ThemeOption = isDark ? 'vercel' : 'dark';
      handleSelectTheme(nextTheme);
    };

    return (
      <div 
        ref={containerRef}
        className={cn("relative inline-block", className)}
      >
        <button
          type="button"
          onClick={handleToggle}
          aria-label={m.theme_switch()}
          title={isDark ? m.theme_current_dark() : m.theme_current_light()}
          className="size-8 rounded-full bg-theme-surface border border-theme-border/70 hover:border-theme-border flex items-center justify-center text-theme-foreground/80 hover:text-theme-foreground shadow-2xs hover:shadow-xs transition-all cursor-pointer focus:outline-none"
        >
          {isDark ? (
            <Moon className="size-4 text-sky-400 transition-transform duration-200 hover:scale-110" />
          ) : (
            <Sun className="size-4 text-amber-500 transition-transform duration-200 hover:scale-110" />
          )}
        </button>
      </div>
    );
  }

  if (!mounted) {
    return null;
  }

  const themes: { id: ThemeOption; label: string; desc: string }[] = [
    { 
      id: 'vercel', 
      label: m.theme_light(), 
      desc: 'Vercel Light',
    },
    { 
      id: 'dark', 
      label: m.theme_dark(), 
      desc: 'Modern Dark',
    },
  ];

  if (variant === 'sidebar-pill') {
 return (
 <div className={cn("flex items-center gap-1 p-0.5 rounded-xl bg-theme-surface/70 border border-theme-border/50 shadow-2xs select-none w-full", className)}>
 {themes.map((t) => {
 const isActive = currentTheme === t.id;
 return (
 <button
 key={t.id}
 type="button"
 onClick={() => handleSelectTheme(t.id)}
 title={`${t.label} (${t.desc})`}
 className={cn(
 "flex-1 py-1 px-2 rounded-lg text-xs font-sans transition-all text-center cursor-pointer select-none",
 isActive
 ? "bg-theme-bg dark:bg-zinc-800 text-theme-foreground dark:text-zinc-100 font-bold shadow-xs border border-theme-border/70 dark:border-zinc-700/80"
 : "text-theme-muted hover:text-theme-foreground hover:bg-theme-bg/40 font-medium"
 )}
 >
 <span>{t.label}</span>
 </button>
 );
 })}
 </div>
 );
 }

 if (variant === 'minimal') {
 return (
 <div className={cn("inline-flex items-center gap-1 p-1 rounded-full bg-theme-surface border border-theme-border/60 shadow-xs select-none", className)}>
 {themes.map((t) => (
 <button
 key={t.id}
 onClick={() => handleSelectTheme(t.id)}
 title={`${t.label} (${t.desc})`}
 className={cn(
 "px-2.5 py-1 rounded-full text-micro font-medium transition-all cursor-pointer flex items-center gap-1.5",
 currentTheme === t.id
 ? "bg-theme-primary text-theme-primary-fg shadow-xs font-semibold"
 : "text-theme-muted hover:text-theme-foreground hover:bg-theme-bg/60"
 )}
 >
 <span>{t.label}</span>
 </button>
 ))}
 </div>
 );
 }

 return (
 <div className={cn("inline-flex items-center p-1 rounded-lg bg-theme-surface/80 border border-theme-border/60 shadow-xs select-none", className)}>
 {themes.map((t) => {
 const isActive = currentTheme === t.id;
 return (
 <button
 key={t.id}
 onClick={() => handleSelectTheme(t.id)}
 className={cn(
 "px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-2 cursor-pointer",
 isActive
 ? "bg-theme-primary text-theme-primary-fg shadow-xs font-semibold"
 : "text-theme-muted hover:text-theme-foreground hover:bg-theme-bg/50"
 )}
 >
 <span>{t.label}</span>
 {isActive && <Check className="size-3 ml-0.5 opacity-80" />}
 </button>
 );
 })}
 </div>
 );
}
