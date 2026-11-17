'use client';

import React from 'react';
import Link from 'next/link';
import { Compass, Search } from 'lucide-react';
import { OpenGitsOctocatLogo } from './OpenGitsOctocatLogo';
import { ThemeSwitcher } from '@/components/ThemeSwitcher';
import { I18nLanguageSwitcher } from '@/components/I18nLanguageSwitcher';
import { UserMenu } from '@/components/UserMenu';
import { UserCreditsPopover } from '@/components/credits/UserCreditsPopover';
import { NotificationBell } from '@/components/notifications/NotificationBell';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSafeSession } from '@/lib/useSafeSession';
import { useGuestStore } from '@/lib/stores/guest-store';
import { toastManager } from '@/components/ui/toast';
import * as m from '@/paraglide/messages';

interface HomeHeaderProps {
  initialUserId?: string | null;
}

export function HomeHeader({ initialUserId }: HomeHeaderProps = {}) {
  const { data: session } = useSafeSession();
  const isAuthenticated = Boolean(session?.user?.id || initialUserId);
  const isGuest = useGuestStore(s => s.isGuest);
  const [isMac, setIsMac] = React.useState(false);

  React.useEffect(() => {
    if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
      setIsMac(/(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent));
    }
  }, []);

  const handleOpenSearch = () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'k',
          metaKey: true,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    }
  };

  const searchLabel = m.placeholder_search().replace(/\.+$/, '');

  return (
    <header className="sticky top-0 z-50 w-full bg-theme-bg/95 backdrop-blur-md">
      <div className="w-full px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between gap-4">
        
        {/* Left: Brand Logo & Title */}
        <div className="flex items-center gap-3 shrink-0">
          <Link href="/" className="flex items-center gap-2.5 select-none">
            <div className="flex items-center justify-center shrink-0">
              <OpenGitsOctocatLogo className="w-6 h-6" />
            </div>
            <span className="text-base font-semibold tracking-tight text-theme-foreground font-mono leading-none">
              opengits
            </span>
          </Link>

          {!isAuthenticated && !isGuest && (
            <button
              type="button"
              onClick={() => {
                useGuestStore.getState().enableGuestMode();
                toastManager.add({
                  type: 'info',
                  title: m.auth_guest_welcome_toast(),
                });
              }}
              className="hidden sm:inline-flex items-center gap-1.5 text-xs font-sans text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer pl-3 border-l border-theme-border/60"
            >
              <Compass className="w-3.5 h-3.5 text-theme-primary" />
              <span>{m.header_guest_explore_nav()}</span>
            </button>
          )}
        </div>

        {/* Right: Unified Controls (Vercel Standard: 32px / h-8 All-in-One Rhythm) */}
        <div className="flex items-center gap-2 shrink-0">
          <TooltipProvider>
            {/* 1. Independent Dedicated Search Button (32px / h-8) */}
            <button
              type="button"
              onClick={handleOpenSearch}
              aria-label={isMac ? `${searchLabel} (⌘ K)` : `${searchLabel} (Ctrl K)`}
              title={isMac ? `${searchLabel} (⌘ K)` : `${searchLabel} (Ctrl K)`}
              className="group flex items-center justify-between gap-3 h-8 px-2.5 sm:px-3 sm:w-40 md:w-44 rounded-lg bg-theme-surface/40 hover:bg-theme-surface border border-theme-border/60 hover:border-theme-border/80 text-xs text-theme-muted hover:text-theme-foreground transition-all cursor-pointer select-none shadow-none"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <Search className="w-3.5 h-3.5 text-theme-muted group-hover:text-theme-foreground transition-colors shrink-0" />
                <span className="hidden sm:inline-block truncate text-xs font-sans text-theme-muted group-hover:text-theme-foreground transition-colors">
                  {searchLabel}
                </span>
              </div>
              <kbd className="hidden sm:inline-flex items-center justify-center px-1.5 py-0.5 rounded text-micro font-mono text-theme-muted/80 bg-theme-surface border border-theme-border/70 group-hover:text-theme-foreground transition-colors">
                {isMac ? '⌘K' : 'Ctrl K'}
              </kbd>
            </button>

            {/* Logged-In User Exclusive: User Credits (32px Ghost Pill) */}
            {isAuthenticated && (
              <UserCreditsPopover />
            )}

            {/* Subtle Hairline Divider (区分业务资产与系统偏好) */}
            {isAuthenticated && (
              <div className="w-px h-4 bg-theme-border/60 mx-0.5 shrink-0 hidden sm:block" />
            )}

            {/* System Utility Icons (Theme + Language + Notifications) */}
            <div className="flex items-center gap-0.5">
              <ThemeSwitcher variant="ghost" />
              <I18nLanguageSwitcher variant="ghost" />
              {isAuthenticated && <NotificationBell />}
            </div>

            {/* User Menu / Avatar with Stable Layout Slot (Zero Layout Shift / 零抖动) */}
            <div className="flex items-center justify-end h-8 shrink-0">
              <UserMenu initialUserId={initialUserId} />
            </div>
          </TooltipProvider>
        </div>

      </div>
    </header>
  );
}
