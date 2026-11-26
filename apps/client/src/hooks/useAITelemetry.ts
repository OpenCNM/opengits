'use client';

import { useEffect, useRef } from 'react';
import { trackEvent, flushQueue, TELEMETRY_EVENTS } from '@/lib/telemetry/beacon';
import { usePathname } from 'next/navigation';
import { useReadingProgressStore } from '@/lib/stores/reading-progress-store';

function findMatchingDocPath(pathname: string, scores: Record<string, number>): string {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 3) return '';
  const slug = parts.slice(3).join('/').toLowerCase();

  const keys = Object.keys(scores);
  if (keys.length === 0) return slug ? `${slug}.md` : 'README.md';

  for (const key of keys) {
    const rawPath = key.includes(':') ? key.substring(key.indexOf(':') + 1) : key;
    const normKey = rawPath.replace(/\.mdx?$/, '').toLowerCase();
    if (normKey === slug || (slug === '' && (normKey === 'readme' || normKey === 'index'))) {
      return rawPath;
    }
  }

  return slug ? `${slug}.md` : 'README.md';
}

function findPrimaryScrollContainer(): Element | null {
  const allElements = Array.from(document.querySelectorAll('main, article, div, section'));
  let bestEl: Element | null = null;
  let bestScrollDist = 0;

  for (const el of allElements) {
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    const isScrollContainer = (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay');

    if (!isScrollContainer || el.clientHeight < 200) continue;

    const dist = el.scrollHeight - el.clientHeight;
    if (dist > bestScrollDist) {
      bestScrollDist = dist;
      bestEl = el;
    }
  }

  return bestEl;
}

function findNearestHeading(): { id: string; top: number } | null {
  if (typeof window === 'undefined') return null;
  const headings = Array.from(document.querySelectorAll('h1[id], h2[id], h3[id], h4[id]'));
  let nearest: { id: string; top: number } | null = null;
  let minDiff = Infinity;

  for (const h of headings) {
    if (!h.id) continue;
    const rect = h.getBoundingClientRect();
    if (rect.top <= 200 && rect.top >= -600) {
      const diff = Math.abs(rect.top - 80);
      if (diff < minDiff) {
        minDiff = diff;
        nearest = { id: h.id, top: Math.round(rect.top) };
      }
    }
  }

  return nearest;
}

export function useAITelemetry() {
  const pathname = usePathname();
  const maxScrollPercentRef = useRef<number>(0);
  const lastFlushedPercentRef = useRef<number>(0);
  const startTimeRef = useRef<number>(Date.now());
  const primaryContainerRef = useRef<Element | null>(null);
  const isNavigatingRef = useRef<boolean>(true);

  useEffect(() => {
    startTimeRef.current = Date.now();
    maxScrollPercentRef.current = 0;
    lastFlushedPercentRef.current = 0;
    primaryContainerRef.current = null;
    isNavigatingRef.current = true;

    const navSettleTimer = setTimeout(() => {
      isNavigatingRef.current = false;
    }, 350);

    const checkScrollDepth = () => {
      if (typeof window === 'undefined') return;
      if (isNavigatingRef.current) return;

      if (!primaryContainerRef.current) {
        primaryContainerRef.current = findPrimaryScrollContainer();
      }

      let maxPercent = 0;
      let hasActiveScrollbar = false;

      const winScrollTop = window.scrollY || document.documentElement.scrollTop || document.body?.scrollTop || 0;
      const winClientHeight = window.innerHeight || document.documentElement.clientHeight || 1;
      const winScrollHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);

      const winDist = winScrollHeight - winClientHeight;
      if (winDist > 50) {
        hasActiveScrollbar = true;
        const p = Math.round((winScrollTop / winDist) * 100);
        maxPercent = Math.max(maxPercent, p);
      }

      const el = primaryContainerRef.current;
      let containerScrollTop = winScrollTop;
      if (el) {
        containerScrollTop = el.scrollTop;
        const dist = el.scrollHeight - el.clientHeight;
        if (dist > 50) {
          hasActiveScrollbar = true;
          const p = Math.round((el.scrollTop / dist) * 100);
          maxPercent = Math.max(maxPercent, p);
        }
      }

      const finalPercent = Math.min(100, Math.max(0, maxPercent));
      maxScrollPercentRef.current = Math.max(maxScrollPercentRef.current, finalPercent);

      const liveScore = maxScrollPercentRef.current;
      if (liveScore > 0) {
        const store = useReadingProgressStore.getState();
        const docPath = findMatchingDocPath(pathname, store.chapterScores);
        if (docPath) {
          const parts = pathname.split('/').filter(Boolean);
          const repoKey = parts.length >= 3 ? `${parts[1]}/${parts[2]}` : undefined;
          store.setChapterScore(docPath, liveScore, repoKey);

          if (containerScrollTop > 0 && repoKey) {
            const nearestHeading = findNearestHeading();
            const posPayload = JSON.stringify({
              scrollTop: Math.round(containerScrollTop),
              headingId: nearestHeading?.id || null,
              headingTop: nearestHeading?.top || null,
              percent: finalPercent,
              timestamp: Date.now(),
            });
            const cacheKey = `reading_pos_v2_${repoKey.toLowerCase()}:${docPath}`;
            try {
              sessionStorage.setItem(cacheKey, posPayload);
              localStorage.setItem(cacheKey, posPayload);
            } catch {
            }
          }
        }
      }

      const currentMax = maxScrollPercentRef.current;
      const progressDelta = currentMax - lastFlushedPercentRef.current;
      const reachedCompletionThreshold = currentMax >= 90 && lastFlushedPercentRef.current < 90;
      if (progressDelta >= 10 || reachedCompletionThreshold) {
        lastFlushedPercentRef.current = currentMax;
        const dwellMs = Math.min(Date.now() - startTimeRef.current, 15 * 60 * 1000);
        trackEvent({
          eventType: 'SCROLL_PROGRESS',
          pageUrl: pathname,
          targetId: pathname,
          duration: dwellMs,
          metadata: { scrollPercent: currentMax }
        });
      }
    };

    const initTimer = setTimeout(() => {
      primaryContainerRef.current = findPrimaryScrollContainer();
      checkScrollDepth();
    }, 800);

    trackEvent({
      eventType: TELEMETRY_EVENTS.PAGE_VIEW,
      pageUrl: pathname,
      targetId: pathname,
      metadata: { scrollPercent: maxScrollPercentRef.current }
    });

    let scrollTimer: NodeJS.Timeout | null = null;

    const handleScroll = () => {
      primaryContainerRef.current = findPrimaryScrollContainer();
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        checkScrollDepth();
      }, 100);
    };

    window.addEventListener('scroll', handleScroll, { passive: true, capture: true });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        primaryContainerRef.current = findPrimaryScrollContainer();
        checkScrollDepth();
      });
      const targetContainer = document.querySelector('main') || document.querySelector('article') || document.body;
      if (targetContainer) {
        resizeObserver.observe(targetContainer);
      }
    }

    const images = Array.from(document.querySelectorAll('img'));
    const imgCleanupFns: Array<() => void> = [];
    images.forEach(img => {
      if (!img.complete) {
        const onLoad = () => {
          primaryContainerRef.current = findPrimaryScrollContainer();
          checkScrollDepth();
        };
        img.addEventListener('load', onLoad, { once: true });
        imgCleanupFns.push(() => img.removeEventListener('load', onLoad));
      }
    });

    const commitProgress = () => {
      checkScrollDepth();
      if (maxScrollPercentRef.current > lastFlushedPercentRef.current) {
        lastFlushedPercentRef.current = maxScrollPercentRef.current;
        const dwellMs = Math.min(Date.now() - startTimeRef.current, 15 * 60 * 1000);
        trackEvent({
          eventType: 'SCROLL_PROGRESS',
          pageUrl: pathname,
          targetId: pathname,
          duration: dwellMs,
          metadata: { scrollPercent: maxScrollPercentRef.current },
          immediate: true,
        });
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        commitProgress();
        flushQueue();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', commitProgress);

    return () => {
      commitProgress();
      flushQueue();
      window.removeEventListener('scroll', handleScroll, { capture: true });
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', commitProgress);
      if (resizeObserver) resizeObserver.disconnect();
      imgCleanupFns.forEach(fn => fn());
      if (scrollTimer) clearTimeout(scrollTimer);
      clearTimeout(initTimer);
      clearTimeout(navSettleTimer);
    };
  }, [pathname]);
}
