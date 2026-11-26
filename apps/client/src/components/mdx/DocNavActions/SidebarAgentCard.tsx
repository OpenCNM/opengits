'use client';
import * as m from '@/paraglide/messages';

import { useEffect } from 'react';
import { Sun, Moon, Type } from 'lucide-react';
import { useReaderAppearanceStore, type ThemeOption } from '@/lib/stores/reader-appearance-store';
import { cn } from '@/lib/utils';
import { FONT_SIZE_OPTIONS, type FontSizeOption } from '@/lib/constants';

export function SidebarAgentCard({
  owner,
  repo,
  repositoryId,
}: {
  owner: string;
  repo: string;
  repositoryId?: string;
}) {
  const currentTheme = useReaderAppearanceStore((s) => s.theme);
  const setTheme = useReaderAppearanceStore((s) => s.setTheme);
  const fontSize = useReaderAppearanceStore((s) => s.fontSize);
  const setFontSize = useReaderAppearanceStore((s) => s.setFontSize);
  const initAppearance = useReaderAppearanceStore((s) => s.initAppearance);

  useEffect(() => {
    initAppearance();
  }, [initAppearance]);

  const themeLabels: Record<ThemeOption, string> = {
    vercel: m.reader_theme_light(),
    dark: m.reader_theme_dark(),
  };
  const fontSizeLabels: Record<FontSizeOption, string> = {
    small: m.reader_font_compact(),
    medium: m.reader_font_standard(),
    large: m.reader_font_comfortable(),
  };

  const handleSelectTheme = (theme: ThemeOption) => {
    setTheme(theme);
  };

  const handleSelectFontSize = (size: FontSizeOption) => {
    setFontSize(size);
  };

  return (
    <div className="my-2 p-3.5 rounded-xl border border-theme-border/60 bg-theme-surface/30 backdrop-blur-xs font-sans shadow-2xs w-full space-y-3.5">
      <div className="space-y-1.5">
        <div className="flex items-center text-caption text-theme-muted font-medium">
          <span className="flex items-center gap-1.5">
            <Sun size={12} className="text-theme-muted" />
            <span>{m.reader_theme()}</span>
          </span>
        </div>
        <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-theme-bg/80 border border-theme-border/60 shadow-inner">
          {(['vercel', 'dark'] as ThemeOption[]).map((t) => {
            const isActive = currentTheme === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => handleSelectTheme(t)}
                className={cn(
                  'relative py-1.5 px-2 text-caption font-medium rounded-md transition-all duration-150 flex items-center justify-center gap-1.5 cursor-pointer select-none',
                  isActive
                    ? 'bg-theme-surface text-theme-primary font-bold shadow-2xs border border-theme-border/80'
                    : 'text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/50'
                )}
              >
                {t === 'vercel' ? (
                  <>
                    <Sun
                      size={12}
                      className={cn(isActive ? 'text-theme-primary' : 'text-theme-muted')}
                    />
                    <span>{themeLabels.vercel}</span>
                  </>
                ) : (
                  <>
                    <Moon
                      size={12}
                      className={cn(isActive ? 'text-theme-primary' : 'text-theme-muted')}
                    />
                    <span>{themeLabels.dark}</span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center text-caption text-theme-muted font-medium">
          <span className="flex items-center gap-1.5">
            <Type size={12} className="text-theme-muted" />
            <span>{m.reader_font_size()}</span>
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-theme-bg/80 border border-theme-border/60 shadow-inner">
          {FONT_SIZE_OPTIONS.map((s) => {
            const isActive = fontSize === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => handleSelectFontSize(s)}
                className={cn(
                  'relative min-w-0 px-1 py-1.5 text-caption font-medium rounded-md transition-all duration-150 flex items-center justify-center gap-1 cursor-pointer select-none',
                  isActive
                    ? 'bg-theme-surface text-theme-primary font-bold shadow-2xs border border-theme-border/80'
                    : 'text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/50'
                )}
              >
                <span className="truncate">{fontSizeLabels[s]}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
