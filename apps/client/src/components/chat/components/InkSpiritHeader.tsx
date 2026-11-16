'use client';

import React from 'react';
import { Pin, ChevronRight, Sparkles, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import * as m from '@/paraglide/messages';

interface InkSpiritHeaderProps {
  isPinned: boolean;
  showPin?: boolean;
  onTogglePin: () => void;
  onClose: () => void;
  onNewChat?: () => void;
  isLoading?: boolean;
}

export function InkSpiritHeader({
  isPinned,
  showPin = true,
  onTogglePin,
  onClose,
  onNewChat,
  isLoading = false,
}: InkSpiritHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-theme-border/50 bg-theme-bg/95 backdrop-blur-md shrink-0 select-none">
      {/* Brand & Assistant Status Info */}
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="relative flex items-center justify-center w-7 h-7 rounded-xl bg-theme-surface border border-theme-border/70 text-theme-primary shadow-2xs shrink-0">
          <Sparkles size={14} />
          <span
            className={cn(
              'absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-theme-bg',
              isLoading ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'
            )}
          />
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-bold text-theme-foreground tracking-wide leading-tight truncate">
            {m.chat_title()}
          </span>
          <span className="text-micro text-theme-muted mt-0.5 leading-none">
            {isLoading ? m.chat_thinking() : 'Online'}
          </span>
        </div>
      </div>

      {/* Action Control Button Group */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* New Chat Reset Button */}
        {onNewChat && (
          <button
            type="button"
            onClick={onNewChat}
            className="flex items-center gap-1 text-xs font-sans text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/80 px-2 py-1 rounded-lg border border-transparent hover:border-theme-border/40 transition-colors cursor-pointer"
            title={m.common_create()}
            aria-label={m.common_create()}
          >
            <RotateCcw size={12} />
            <span className="text-micro">{m.common_create()}</span>
          </button>
        )}

        {/* Pin / Lock Toggle Button (overlay mode only) */}
        {showPin && (
          <button
            type="button"
            onClick={onTogglePin}
            className={cn(
              'p-1.5 rounded-lg border transition-all cursor-pointer flex items-center justify-center',
              isPinned
                ? 'text-theme-primary border-theme-primary/40 bg-theme-surface/70'
                : 'text-theme-muted border-transparent hover:border-theme-border/40 hover:text-theme-foreground hover:bg-theme-surface/80'
            )}
            title={isPinned ? m.chat_pin_locked() : m.chat_pin_unlocked()}
            aria-label={isPinned ? m.chat_pin_locked() : m.chat_pin_unlocked()}
          >
            <Pin
              size={13}
              className={cn(
                'transition-transform duration-300',
                isPinned ? 'rotate-45 text-theme-primary' : '-rotate-45 opacity-60'
              )}
            />
          </button>
        )}

        {/* Collapse Action Button */}
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-lg text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/80 border border-transparent hover:border-theme-border/40 transition-colors cursor-pointer"
          title={m.common_collapse()}
          aria-label={m.common_collapse()}
        >
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}
