'use client';

import * as m from '@/paraglide/messages';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Badge } from '@/components/ui/badge';
import { STORAGE_KEYS } from '@/lib/constants';

export interface AnnouncementItem {
  id: string;
  title: string;
  subtitle?: string | null;
  targetUrl?: string | null;
  badge?: string | null;
  dismissible: boolean;
}

export function AnnouncementBanner({ announcements }: { announcements?: AnnouncementItem[] | null }) {
  const [closed, setClosed] = useState<string[]>([]);

  useEffect(() => {
    try {
      setClosed(JSON.parse(localStorage.getItem(STORAGE_KEYS.CLOSED_ANNOUNCEMENTS) || '[]'));
    } catch { }
  }, []);

  const activeItem = announcements?.find((a) => !closed.includes(a.id)) || null;

  const dismiss = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const next = [...closed, id];
    setClosed(next);
    try {
      localStorage.setItem(STORAGE_KEYS.CLOSED_ANNOUNCEMENTS, JSON.stringify(next));
      document.cookie = `${STORAGE_KEYS.CLOSED_ANNOUNCEMENTS}=${encodeURIComponent(JSON.stringify(next))}; path=/; max-age=31536000; SameSite=Lax`;
    } catch { }
  };

  return (
    <AnimatePresence mode="wait">
      {activeItem && (
        <motion.aside
          key={activeItem.id}
          initial={{ height: 'auto', opacity: 1 }}
          exit={{
            height: 0,
            opacity: 0,
            borderBottomWidth: 0,
            transition: {
              height: { duration: 0.3, ease: [0.32, 0.72, 0, 1] },
              opacity: { duration: 0.2, ease: 'easeOut' },
            },
          }}
          className="w-full overflow-hidden bg-zinc-950 text-zinc-100 dark:bg-black dark:text-zinc-100 border-b border-zinc-800/80 z-40 relative select-none"
          role="region"
          aria-label={activeItem.title}
        >
          <div className="w-full px-5 lg:px-8 py-2.5 min-h-[42px] flex items-center justify-between gap-4 text-xs sm:text-sm">
            <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1 flex-wrap sm:flex-nowrap">
              <Badge
                variant="outline"
                size="lg"
                className="h-6.5 px-3 rounded-full font-sans text-xs font-semibold bg-white/15 text-white border-white/25 shrink-0 shadow-2xs"
              >
                {activeItem.badge || m.banner_default_badge()}
              </Badge>

              <span className="font-sans font-medium text-white tracking-normal truncate">
                {activeItem.title}
              </span>

              {activeItem.subtitle && (
                <span className="text-zinc-400 text-xs sm:text-sm hidden md:inline truncate max-w-[500px]">
                  {activeItem.subtitle}
                </span>
              )}

              {activeItem.targetUrl && (
                <Link
                  href={activeItem.targetUrl}
                  className="group inline-flex items-center gap-1 font-medium text-zinc-200 hover:text-white transition-colors shrink-0 ml-0.5"
                >
                  <span className="underline underline-offset-4">{m.banner_view_cta()}</span>
                  <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5 shrink-0" />
                </Link>
              )}
            </div>

            {activeItem.dismissible && (
              <button
                type="button"
                onClick={(e) => dismiss(e, activeItem.id)}
                className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer flex items-center justify-center shrink-0 -mr-1"
                aria-label={m.banner_close_aria()}
                title={m.banner_close_aria()}
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
