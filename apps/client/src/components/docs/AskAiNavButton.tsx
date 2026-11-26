'use client';

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useModalStore } from '@/lib/stores/modal-store';
import { requireAiCapability } from '@/lib/permissions/permission-gateway';
import * as m from '@/paraglide/messages';

export interface AskAiNavButtonProps {
  className?: string;
}

export function AskAiNavButton({ className }: AskAiNavButtonProps) {
  const [isMac, setIsMac] = useState(false);
  const openChatDrawer = useModalStore((s) => s.openChatDrawer);
  const isChatDrawerOpen = useModalStore((s) => s.isChatDrawerOpen);

  useEffect(() => {
    if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
      setIsMac(/(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent));
    }
  }, []);

  const buttonLabel = m.nav_ask_ai();
  const shortcutLabel = isMac ? '⌘I' : 'Ctrl I';

  return (
    <AnimatePresence>
      {!isChatDrawerOpen && (
        <motion.div
          key="top-right-ask-ai"
          initial={{ opacity: 0, y: -10, scale: 0.92 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.92 }}
          transition={{ type: 'spring', stiffness: 400, damping: 28 }}
          className={cn('fixed top-3.5 right-14 md:right-6 z-[70] select-none', className)}
        >
          <motion.button
            type="button"
            onClick={() => requireAiCapability(() => openChatDrawer(), m.gate_reason_ai_chat())}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.96 }}
            aria-label={`${buttonLabel} (${shortcutLabel})`}
            title={`${buttonLabel} (${shortcutLabel})`}
            className="group relative flex items-center gap-2 h-8 pl-2.5 pr-2 sm:pr-2.5 rounded-full bg-theme-bg/80 hover:bg-theme-bg/95 backdrop-blur-xl border border-theme-border/70 hover:border-theme-primary/40 shadow-xs hover:shadow-md transition-all duration-300 cursor-pointer overflow-hidden"
          >
            <div className="absolute inset-0 bg-gradient-to-r from-theme-primary/5 via-transparent to-theme-primary/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

            <div className="relative flex items-center justify-center shrink-0">
              <Sparkles className="w-3.5 h-3.5 text-theme-primary transition-all duration-300 group-hover:rotate-12 group-hover:scale-110" />
              <span className="absolute -inset-0.5 rounded-full bg-theme-primary/20 blur-[3px] opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
            </div>

            <span className="hidden sm:inline-block text-xs font-semibold tracking-tight text-theme-foreground/90 group-hover:text-theme-foreground transition-colors font-sans">
              {buttonLabel}
            </span>

            <kbd className="hidden sm:inline-flex items-center justify-center px-1.5 py-0.5 rounded-full text-micro font-mono text-theme-muted group-hover:text-theme-foreground bg-theme-surface/80 border border-theme-border/60 transition-colors">
              {shortcutLabel}
            </kbd>
          </motion.button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
