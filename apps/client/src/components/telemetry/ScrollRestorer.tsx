'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useReadingProgressStore } from '@/lib/stores/reading-progress-store';
import { ArrowUp, Bookmark } from 'lucide-react';
import * as m from '@/paraglide/messages';

interface ScrollRestorerProps {
  docPath: string;
  owner: string;
  repo: string;
}

function findScrollContainer(): { el: Element | Window; scrollHeight: number; clientHeight: number } {
  if (typeof window === 'undefined') {
    return { el: window, scrollHeight: 0, clientHeight: 0 };
  }

  const mainEl = document.querySelector('main') || document.querySelector('article');
  if (mainEl && mainEl.scrollHeight - mainEl.clientHeight > 100) {
    const style = window.getComputedStyle(mainEl);
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
      return { el: mainEl, scrollHeight: mainEl.scrollHeight, clientHeight: mainEl.clientHeight };
    }
  }

  const docEl = document.documentElement || document.body;
  const winHeight = window.innerHeight || docEl.clientHeight || 1;
  const winScrollHeight = Math.max(docEl.scrollHeight, document.body?.scrollHeight || 0);

  return { el: window, scrollHeight: winScrollHeight, clientHeight: winHeight };
}

function scrollToTop() {
  const { el } = findScrollContainer();
  if (el === window) {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  } else {
    (el as Element).scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }
}

function alignHeadingAnchor(el: Window | Element, targetHeadingId: string, headingTopOffset?: number | null) {
  const headingEl = document.getElementById(targetHeadingId);
  if (!headingEl) return;

  const rect = headingEl.getBoundingClientRect();
  const expectedTop = headingTopOffset ?? 80;
  const diff = rect.top - expectedTop;
  if (Math.abs(diff) <= 10) return;

  if (el === window) {
    window.scrollBy({ top: diff, behavior: 'instant' as ScrollBehavior });
  } else {
    (el as Element).scrollBy({ top: diff, behavior: 'instant' as ScrollBehavior });
  }
}

export function ScrollRestorer({ docPath, owner, repo }: ScrollRestorerProps) {
  const [restoredScore, setRestoredScore] = useState<number | null>(null);
  const [showToast, setShowToast] = useState(false);
  const isRestoredRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }

    isRestoredRef.current = false;
    setShowToast(false);
    setRestoredScore(null);

    if (window.location.hash) {
      const rawHash = window.location.hash.slice(1);
      if (rawHash) {
        const hashId = decodeURIComponent(rawHash);
        const scrollToHash = () => {
          const target = document.getElementById(hashId);
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        };
        scrollToHash();
        const timer1 = setTimeout(scrollToHash, 120);
        const timer2 = setTimeout(scrollToHash, 400);
        return () => {
          clearTimeout(timer1);
          clearTimeout(timer2);
        };
      }
      return;
    }

    const repoKey = `${owner}/${repo}`.toLowerCase();
    const cacheKey = `reading_pos_v2_${repoKey}:${docPath}`;

    let exactScrollTop: number | null = null;
    let targetHeadingId: string | null = null;
    let headingTopOffset: number | null = null;
    let localCachePercent = 0;

    try {
      const rawLocal = sessionStorage.getItem(cacheKey) || localStorage.getItem(cacheKey);
      if (rawLocal) {
        const parsed = JSON.parse(rawLocal);
        if (typeof parsed.scrollTop === 'number') exactScrollTop = parsed.scrollTop;
        if (typeof parsed.headingId === 'string') targetHeadingId = parsed.headingId;
        if (typeof parsed.headingTop === 'number') headingTopOffset = parsed.headingTop;
        if (typeof parsed.percent === 'number') localCachePercent = parsed.percent;
      }
    } catch {
    }

    const performRestoration = () => {
      if (isRestoredRef.current) return;

      const store = useReadingProgressStore.getState();
      const storeScore = store.getChapterScore(docPath, repoKey);
      const savedScore = localCachePercent || storeScore;

      if ((exactScrollTop === null || exactScrollTop < 50) && (savedScore < 5 || savedScore >= 95)) {
        if (!window.location.hash) {
          scrollToTop();
          requestAnimationFrame(scrollToTop);
          setTimeout(scrollToTop, 50);
        }
        return;
      }

      const { el, scrollHeight, clientHeight } = findScrollContainer();
      const scrollableDist = scrollHeight - clientHeight;
      let targetTop = 0;

      if (exactScrollTop !== null && exactScrollTop > 0) {
        targetTop = Math.min(scrollableDist, exactScrollTop);
      } else if (scrollableDist > 100) {
        targetTop = Math.round((scrollableDist * savedScore) / 100);
      }

      if (targetTop > 30) {
        if (el === window) {
          window.scrollTo({ top: targetTop, behavior: 'instant' as ScrollBehavior });
        } else {
          (el as Element).scrollTo({ top: targetTop, behavior: 'instant' as ScrollBehavior });
        }

        if (targetHeadingId) {
          alignHeadingAnchor(el, targetHeadingId, headingTopOffset);
        }

        isRestoredRef.current = true;
        setRestoredScore(savedScore || 50);
        setShowToast(true);
      }
    };

    performRestoration();
    const retryTimer1 = setTimeout(performRestoration, 80);
    const retryTimer2 = setTimeout(performRestoration, 300);

    return () => {
      clearTimeout(retryTimer1);
      clearTimeout(retryTimer2);
    };
  }, [docPath, owner, repo]);

  useEffect(() => {
    if (!showToast) return;
    const timer = setTimeout(() => {
      setShowToast(false);
    }, 4000);
    return () => clearTimeout(timer);
  }, [showToast]);

  if (!showToast || restoredScore === null) {
    return null;
  }

  const handleScrollToTop = () => {
    const { el } = findScrollContainer();
    if (el === window) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      (el as Element).scrollTo({ top: 0, behavior: 'smooth' });
    }
    setShowToast(false);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-2.5 rounded-xl border border-theme-border bg-theme-surface/95 text-theme-foreground backdrop-blur-md shadow-lg text-xs font-mono select-none transition-all duration-300 animate-in fade-in slide-in-from-bottom-3"
    >
      <div className="flex items-center gap-2">
        <Bookmark className="w-3.5 h-3.5 text-theme-primary shrink-0" />
        <span>{m.telemetry_scroll_restored({ score: restoredScore })}</span>
      </div>
      <button
        onClick={handleScrollToTop}
        className="ml-1 px-2.5 py-1 rounded-lg bg-theme-bg hover:bg-theme-border/40 text-theme-foreground hover:text-theme-primary font-serif font-bold text-xs transition-colors cursor-pointer border border-theme-border flex items-center gap-1 shrink-0"
      >
        <ArrowUp className="w-3 h-3" />
        <span>{m.common_back_to_top()}</span>
      </button>
      <button
        onClick={() => setShowToast(false)}
        className="text-theme-muted hover:text-theme-foreground transition-colors ml-1 p-0.5"
        title={m.common_close()}
      >
        ✕
      </button>
    </div>
  );
}
