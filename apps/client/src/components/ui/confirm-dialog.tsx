'use client';
import React from 'react';
import * as m from '@/paraglide/messages';
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose
} from '@/components/ui/alert-dialog';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'primary' | 'default';
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  cancelText,
  variant = 'danger',
  onConfirm
}: ConfirmDialogProps) {
  const resolvedConfirmText = confirmText ?? m.common_confirm();
  const resolvedCancelText = cancelText ?? m.common_cancel();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup className="bg-theme-bg border border-theme-border shadow-2xl rounded-sm p-6 max-w-md font-serif text-theme-foreground select-none z-[9999]">
        <AlertDialogHeader className="p-0 text-left">
          <AlertDialogTitle className="font-serif font-bold text-base text-stone-850 flex items-center gap-2">
            <span>{title}</span>
          </AlertDialogTitle>
          {description && (
            <AlertDialogDescription className="font-sans text-xs text-theme-muted leading-relaxed mt-2.5">
              {description}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter className="border-t-0 p-0 mt-6 flex justify-end gap-3 font-sans">
          <AlertDialogClose
            onClick={() => onOpenChange(false)}
            className="px-4 py-1.5 text-xs rounded-sm text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-colors cursor-pointer border border-theme-border"
          >
            {resolvedCancelText}
          </AlertDialogClose>
          <button
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
            className={`px-4 py-1.5 text-xs rounded-sm transition-colors font-medium cursor-pointer ${
              variant === 'danger'
                ? 'bg-theme-accent text-white hover:bg-theme-accent/90'
                : variant === 'warning'
                ? 'bg-amber-600 text-white hover:bg-amber-700'
                : 'bg-theme-primary text-theme-primary-fg hover:opacity-90'
            }`}
          >
            {resolvedConfirmText}
          </button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
