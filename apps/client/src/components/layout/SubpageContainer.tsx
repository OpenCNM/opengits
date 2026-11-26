'use client';

import * as m from '@/paraglide/messages';
import React, { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { UserMenu } from '@/components/UserMenu';
import { NotificationBell } from '@/components/notifications/NotificationBell';

interface SubpageContainerProps {
  children: ReactNode;
  maxWidth?: '2xl' | '3xl' | '4xl' | '5xl' | '6xl';
  backHref?: string;
  backLabel?: string;
  headerNav?: ReactNode;
  className?: string;
  showNotificationBell?: boolean;
  showUserMenu?: boolean;
}

export function SubpageContainer({
  children,
  maxWidth = '5xl',
  backHref = '/',
  backLabel,
  headerNav,
  className = '',
  showNotificationBell = true,
  showUserMenu = true,
}: SubpageContainerProps) {
  const maxWidthClass = {
    '2xl': 'max-w-2xl',
    '3xl': 'max-w-3xl',
    '4xl': 'max-w-4xl',
    '5xl': 'max-w-5xl',
    '6xl': 'max-w-6xl',
  }[maxWidth];

  return (
    <div className="min-h-screen bg-theme-bg font-sans text-theme-foreground">
      <div className={`${maxWidthClass} mx-auto px-4 py-8 sm:py-12 ${className}`}>
        <div className="mb-6 flex items-center justify-between gap-4">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-sans text-theme-foreground border border-theme-border/60 hover:border-theme-primary hover:text-theme-primary transition-colors cursor-pointer select-none shadow-2xs shrink-0"
            title={backLabel || m.account_back_to_workspace()}
          >
            <ChevronLeft size={16} />
            <span>{backLabel || m.account_back_to_workspace()}</span>
          </Link>
          <div className="flex items-center gap-2 sm:gap-3">
            {headerNav}
            {showNotificationBell && <NotificationBell />}
            {showUserMenu && (
              <div className="flex items-center justify-end min-h-[38px] min-w-[38px] shrink-0">
                <UserMenu />
              </div>
            )}
          </div>
        </div>

        <main>{children}</main>
      </div>
    </div>
  );
}
