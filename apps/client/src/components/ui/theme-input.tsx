'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ThemedInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
 wrapperClassName?: string;
 icon?: React.ReactNode;
 badge?: React.ReactNode;
 action?: React.ReactNode;
}

export const ThemedInput = React.forwardRef<HTMLInputElement, ThemedInputProps>(
  ({ className, wrapperClassName, icon, badge, action, type = 'text', ...props }, ref) => {
    return (
      <div
        className={cn(
          'flex w-full items-center gap-2.5 px-3.5 py-1.5 rounded-xl border border-theme-border bg-theme-surface/90 hover:border-theme-border hover:bg-theme-surface focus-within:border-theme-primary focus-within:ring-2 focus-within:ring-theme-primary/10 shadow-2xs transition-all',
          wrapperClassName
        )}
      >
        {badge && (
          <div className="shrink-0 select-none">
            {typeof badge === 'string' ? (
              <span className="inline-flex items-center justify-center border border-theme-primary/40 bg-theme-primary/10 text-theme-primary text-xs font-sans font-bold px-2 py-0.5 rounded-md leading-none shadow-2xs">
                {badge}
              </span>
            ) : (
              badge
            )}
          </div>
        )}
        {icon && <div className="shrink-0 text-theme-muted flex items-center justify-center">{icon}</div>}
        <input
          ref={ref}
          type={type}
          className={cn('flex-1 h-9 w-full min-w-0 bg-transparent border-none outline-none font-sans text-xs md:text-sm text-theme-foreground placeholder:text-theme-muted/60', className)}
          {...props}
        />
        {action && <div className="shrink-0 flex items-center">{action}</div>}
      </div>
    );
  }
);

ThemedInput.displayName = 'ThemedInput';
