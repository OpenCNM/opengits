'use client';

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useModalStore } from '@/lib/stores/modal-store';
import * as m from '@/paraglide/messages';

export interface AskAiNavButtonProps {
  className?: string;
}

/**
 * 屏幕右上角固定悬浮 Ask AI 胶囊 (科技感 & 极致毛玻璃高级感设计)
 * - 位置：固定于视口右上角 (top-3.5 right-4 sm:right-6)，远离右下角通知与进度冲突区
 * - 材质：毛玻璃晶体质感 + 环形微光边框 + 细腻动态悬浮微交互
 * - 智能避让：AI 抽屉从右侧滑出时自动平滑隐去，关闭后优雅弹现
 * - 响应式：移动端收拢为精巧发光图标按钮，桌面端展示完整科技胶囊与快捷键
 */
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
            onClick={() => openChatDrawer()}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.96 }}
            aria-label={`${buttonLabel} (${shortcutLabel})`}
            title={`${buttonLabel} (${shortcutLabel})`}
            className="group relative flex items-center gap-2 h-8 pl-2.5 pr-2 sm:pr-2.5 rounded-full bg-theme-bg/80 hover:bg-theme-bg/95 backdrop-blur-xl border border-theme-border/70 hover:border-theme-primary/40 shadow-xs hover:shadow-md transition-all duration-300 cursor-pointer overflow-hidden"
          >
            {/* 科技感微光流动底衬 */}
            <div className="absolute inset-0 bg-gradient-to-r from-theme-primary/5 via-transparent to-theme-primary/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

            {/* AI 灵动图标 (带悬浮微光与自转微动效) */}
            <div className="relative flex items-center justify-center shrink-0">
              <Sparkles className="w-3.5 h-3.5 text-theme-primary transition-all duration-300 group-hover:rotate-12 group-hover:scale-110" />
              <span className="absolute -inset-0.5 rounded-full bg-theme-primary/20 blur-[3px] opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
            </div>

            {/* 提问文案 */}
            <span className="hidden sm:inline-block text-xs font-semibold tracking-tight text-theme-foreground/90 group-hover:text-theme-foreground transition-colors font-sans">
              {buttonLabel}
            </span>

            {/* 科技质感晶体快捷键徽标 */}
            <kbd className="hidden sm:inline-flex items-center justify-center px-1.5 py-0.5 rounded-full text-micro font-mono text-theme-muted group-hover:text-theme-foreground bg-theme-surface/80 border border-theme-border/60 transition-colors">
              {shortcutLabel}
            </kbd>
          </motion.button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
