'use client';

import React from 'react';
import { cn } from '@/lib/utils';

export type OgLoadingSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | number;

export interface OgSpinnerProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: OgLoadingSize;
  speedSec?: number;
  showTrack?: boolean;
  svgClassName?: string;
}

const SIZE_MAP: Record<'xs' | 'sm' | 'md' | 'lg' | 'xl', number> = {
  xs: 14,
  sm: 18,
  md: 28,
  lg: 48,
  xl: 56,
};

function resolveSize(size: OgLoadingSize): number {
  if (typeof size === 'number') return size;
  return SIZE_MAP[size] ?? 28;
}

export function OgSpinner({
  size = 'md',
  speedSec = 1.2,
  showTrack = true,
  className,
  svgClassName,
  style,
  ...props
}: OgSpinnerProps) {
  const pixelSize = resolveSize(size);

  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn("relative inline-flex items-center justify-center shrink-0 select-none text-current", className)}
      style={{
        width: pixelSize,
        height: pixelSize,
        ['--og-dur' as string]: `${speedSec}s`,
        ...style,
      }}
      {...props}
    >
      <svg
        viewBox="0 0 32 32"
        className={cn("w-full h-full overflow-visible", svgClassName)}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {showTrack && (
          <g className="opacity-[0.08]" stroke="currentColor" strokeWidth="1.2">
            <circle cx="10.5" cy="14" r="5" />
            <circle cx="21" cy="12.5" r="3.8" />
            <path d="M24.8 12.5v9.5c0 3-2.2 4.8-5.8 4.8h-4" />
          </g>
        )}

        <circle
          cx="10.5"
          cy="14"
          r="5"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="animate-og-confluence-o"
        />

        <g className="animate-og-confluence-g">
          <circle cx="21" cy="12.5" r="3.8" stroke="currentColor" strokeWidth="2.5" />
          <path
            d="M24.8 12.5v9.5c0 3-2.2 4.8-5.8 4.8h-4"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </g>
      </svg>
    </div>
  );
}

export interface OgLoadingProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: OgLoadingSize;
  text?: React.ReactNode;
  fullPage?: boolean;
  inline?: boolean;
  speedSec?: number;
  showTrack?: boolean;
  iconClassName?: string;
  textClassName?: string;
}

export function OgLoading({
  size,
  text,
  fullPage = false,
  inline = false,
  speedSec = 1.2,
  showTrack = true,
  className,
  iconClassName,
  textClassName,
  ...props
}: OgLoadingProps) {
  const effectiveSize = size ?? (fullPage ? 'xl' : inline ? 'sm' : 'lg');

  if (inline) {
    return (
      <div
        role="status"
        className={cn("inline-flex items-center gap-2 select-none text-current", className)}
        {...props}
      >
        <OgSpinner
          size={effectiveSize}
          speedSec={speedSec}
          showTrack={showTrack}
          className={iconClassName}
        />
        {text && (
          <span className={cn("text-xs font-sans tracking-normal", textClassName)}>
            {text}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center justify-center gap-3 select-none text-theme-foreground transition-opacity",
        fullPage ? "min-h-[70vh] w-full p-6 bg-theme-bg" : "py-8",
        className
      )}
      {...props}
    >
      <OgSpinner
        size={effectiveSize}
        speedSec={speedSec}
        showTrack={showTrack}
        className={iconClassName}
      />
      {text && (
        <div
          className={cn(
            "text-xs font-mono tracking-wider text-theme-muted animate-pulse text-center max-w-xs",
            textClassName
          )}
        >
          {text}
        </div>
      )}
    </div>
  );
}
