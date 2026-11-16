'use client';

import { useEffect, useRef } from 'react';

/**
 * 通知未读数 SSE 订阅。
 *
 * 服务端 `/api/notifications/stream` 在快照变化时推 `notifications` 事件；
 * EventSource 断线由浏览器自动重连（服务端也会周期性换新连接）。
 * 回退策略：环境不支持 EventSource 或 SSE 连接持续失败时，降级为轮询。
 */

const STREAM_URL = '/api/notifications/stream';
const FALLBACK_POLL_INTERVAL_MS = 60_000;
/** 连续失败达到该次数后本次会话降级为轮询（避免登录态失效时无限重连） */
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
          // 帧解析失败忽略，等下一帧
        }
      });
      source.onopen = () => {
        consecutiveErrors = 0;
      };
      source.onerror = () => {
        // EventSource 会自动重连；这里只统计失败次数，超限降级轮询
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

    // 回到前台时主动对账一次（SSE 期间可能丢帧/换连接）
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
