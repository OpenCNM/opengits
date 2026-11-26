'use client';

import React from 'react';
import { cn } from '@/lib/utils';

export function OpenGitsOctocatLogo({
  className = "w-6 h-6",
  fillClassName,
}: {
  className?: string;
  fillClassName?: string;
}) {
  return (
    <div className={cn("relative inline-flex items-center justify-center shrink-0 select-none text-theme-foreground", className)} title="opengits">
      <svg className="w-full h-full" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="32" height="32" rx="7" className={cn("fill-current transition-colors", fillClassName)} />
        <circle cx="10.5" cy="14" r="5" className="stroke-theme-bg" strokeWidth="2.5" />
        <circle cx="21" cy="12.5" r="3.8" className="stroke-theme-bg" strokeWidth="2.5" />
        <path d="M24.8 12.5v9.5c0 3-2.2 4.8-5.8 4.8h-4" className="stroke-theme-bg" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </div>
  );
}
