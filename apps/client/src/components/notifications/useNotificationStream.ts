'use client';

import { useEffect, useRef } from 'react';

const STREAM_URL = '/api/notifications/stream';
const FALLBACK_POLL_INTERVAL_MS = 60_000;
const MAX_CONSECUTIVE_ERRORS = 3;

export function useNotificationStream(
  isLoggedIn: boolean,
  onSnapshot: (unreadCount: number) => void,
  fallbackFetch: () => Promise<void>
) {
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;

  const fallbackFetchRef = useRef(fallbackFetch);
  fallbackFetchRef.current = fallbackFetch;

  useEffect(() => {
    if (!isLoggedIn || typeof window === 'undefined') return;
    if (typeof EventSource === 'undefined') {
      const timer = setInterval(() => void fallbackFetchRef.current(), FALLBACK_POLL_INTERVAL_MS);
      void fallbackFetchRef.current();
      return () => clearInterval(timer);
    }

    let source: EventSource | null = null;
    let consecutiveErrors = 0;
    let degraded = false;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (fallbackTimer) return;
      void fallbackFetchRef.current();
      fallbackTimer = setInterval(() => void fallbackFetchRef.current(), FALLBACK_POLL_INTERVAL_MS);
    };

    const connect = () => {
      if (degraded) return;
      source = new EventSource(STREAM_URL);
      source.addEventListener('notifications', (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as { unreadCount?: number };
          if (typeof payload.unreadCount === 'number') {
            onSnapshotRef.current(payload.unreadCount);
          }
        } catch {
        }
      });
      source.onopen = () => {
        consecutiveErrors = 0;
      };
      source.onerror = () => {
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          degraded = true;
          source?.close();
          source = null;
          startPolling();
        }
      };
    };

    connect();

    const onVisible = () => {
      if (document.visibilityState === 'visible') void fallbackFetchRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      source?.close();
      if (fallbackTimer) clearInterval(fallbackTimer);
    };
  }, [isLoggedIn]);
}
