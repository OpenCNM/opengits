'use client';

import { useState, useEffect, useCallback } from 'react';
import { STORAGE_KEYS } from '@/lib/constants';

const DESKTOP_DOCK_BREAKPOINT_PX = 1024;
const AI_PANEL_MIN_WIDTH_PX = 320;
const AI_PANEL_MAX_WIDTH_PX = 420;
const AI_PANEL_VIEWPORT_RATIO = 0.27;

function computeDockedPanelWidth(viewportWidth: number): number {
  return Math.round(
    Math.min(
      AI_PANEL_MAX_WIDTH_PX,
      Math.max(AI_PANEL_MIN_WIDTH_PX, viewportWidth * AI_PANEL_VIEWPORT_RATIO)
    )
  );
}

interface UseSplitCanvasPinOptions {
  isChatOpen: boolean;
  setIsChatOpen: (open: boolean) => void;
}

export function useSplitCanvasPin({ isChatOpen, setIsChatOpen }: UseSplitCanvasPinOptions) {
  const [isDesktop, setIsDesktop] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.innerWidth >= DESKTOP_DOCK_BREAKPOINT_PX;
  });

  const [panelWidth, setPanelWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 380;
    return computeDockedPanelWidth(window.innerWidth);
  });

  const [isPinned, setIsPinned] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(STORAGE_KEYS.AGENT_PINNED) === 'true';
    }
    return false;
  });

  const togglePin = useCallback(() => {
    setIsPinned((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        localStorage.setItem(STORAGE_KEYS.AGENT_PINNED, String(next));
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia(`(min-width: ${DESKTOP_DOCK_BREAKPOINT_PX}px)`);
    const updateViewport = () => {
      setIsDesktop(mediaQuery.matches);
      setPanelWidth(computeDockedPanelWidth(window.innerWidth));
    };

    updateViewport();
    mediaQuery.addEventListener('change', updateViewport);
    window.addEventListener('resize', updateViewport);
    return () => {
      mediaQuery.removeEventListener('change', updateViewport);
      window.removeEventListener('resize', updateViewport);
    };
  }, []);

  useEffect(() => {
    if (isDesktop || !isChatOpen || isPinned) return;

    const handleClickOutside = (e: MouseEvent) => {
      const selection = window.getSelection();
      if (selection && selection.toString().trim().length > 0) return;

      const container = document.getElementById('ink-spirit-container');
      if (container && !container.contains(e.target as Node)) {
        setIsChatOpen(false);
      }
    };

    window.addEventListener('mousedown', handleClickOutside);
    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isDesktop, isChatOpen, isPinned, setIsChatOpen]);

  return {
    isDesktop,
    panelWidth,
    isPinned,
    togglePin,
  };
}
