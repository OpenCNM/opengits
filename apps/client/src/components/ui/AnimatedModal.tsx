'use client';

import React, { ReactNode } from 'react';
import * as m from '@/paraglide/messages';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ResponsiveCloseIcon } from '@/components/ui/four-petal-close-icon';

export type AnimatedModalSize =
  | 'sm'
  | 'md'
  | 'lg'
  | 'xl'
  | '2xl'
  | '4xl'
  | '5xl'
  | '6xl'
  | 'workbench'
  | 'full';

export interface AnimatedModalProps {
  isOpen: boolean;
  onClose: () => void;
  size?: AnimatedModalSize;
  icon?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  headerRight?: ReactNode;
  showHeader?: boolean;
  showCloseButton?: boolean;
  preventBackdropClose?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

const SIZE_CLASSES: Record<AnimatedModalSize, string> = {
  sm: 'max-w-md w-full',
  md: 'max-w-lg w-full',
  lg: 'max-w-xl w-full',
  xl: 'max-w-2xl w-full',
  '2xl': 'max-w-3xl w-full',
  '4xl': 'max-w-4xl w-full',
  '5xl': 'max-w-5xl w-full',
  '6xl': 'max-w-6xl w-full',
  workbench: 'max-w-5xl w-[95vw] h-[88vh] max-h-[850px]',
  full: 'max-w-[95vw] w-[95vw] h-[92vh]',
};

export function AnimatedModal({
  isOpen,
  onClose,
  size = 'lg',
  icon,
  title,
  subtitle,
  headerRight,
  showHeader = true,
  showCloseButton = true,
  preventBackdropClose = false,
  className = '',
  bodyClassName = '',
  children,
}: AnimatedModalProps) {
  return (
    <Dialog
      open={isOpen}
      disablePointerDismissal={preventBackdropClose}
      onOpenChange={(open, details) => {
        if (!open) {
          if (preventBackdropClose && details?.reason === 'outside-press') return;
          onClose();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={`${SIZE_CLASSES[size]} bg-theme-bg border border-theme-border rounded-2xl shadow-2xl overflow-hidden flex flex-col !p-0 select-none ${className}`}
      >
        {showHeader && (
          <div className="flex items-center justify-between px-6 py-3.5 border-b border-theme-border/40 bg-theme-bg/60 shrink-0 select-none w-full text-left gap-4">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              {icon && (
                <span className="flex items-center justify-center w-7 h-7 rounded-xl bg-theme-primary/10 text-theme-primary shrink-0">
                  {icon}
                </span>
              )}
              <div className="min-w-0">
                {title && (
                  <h2 className="text-base font-bold text-theme-foreground truncate">
                    {title}
                  </h2>
                )}
                {subtitle && (
                  <p className="text-xs text-theme-muted truncate mt-0.5">
                    {subtitle}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {headerRight}
              {showCloseButton && (
                <button
                  type="button"
                  onClick={onClose}
                  aria-label={m.common_close()}
                  className="rounded-full bg-transparent border border-transparent text-theme-primary/80 hover:text-theme-accent hover:bg-theme-surface/90 hover:border-theme-border/80 hover:shadow-xs p-1.5 cursor-pointer transition-colors flex items-center justify-center select-none"
                >
                  <ResponsiveCloseIcon />
                </button>
              )}
            </div>
          </div>
        )}

        <div className={`flex-1 overflow-y-auto custom-scrollbar ${bodyClassName}`}>
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
