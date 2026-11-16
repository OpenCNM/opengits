import { TELEMETRY_EVENTS, type TelemetryEventType } from './events';
import { useDocumentStore } from '@/lib/stores/document-store';
import { useReadingProgressStore } from '@/lib/stores/reading-progress-store';
import { isTelemetryAuthenticated, setTelemetryAuthenticated } from './auth-gate';

export { TELEMETRY_EVENTS, type TelemetryEventType };
export type * from './events';
// 鉴权门 re-export：AuthProvider 的既有 import 路径不变（插件化解耦后门移至 auth-gate）
export { setTelemetryAuthenticated };

export interface TelemetryEventPayload {
  eventType: TelemetryEventType;
  pageUrl?: string;
  targetId?: string;
  duration?: number;
  metadata?: Record<string, any>;
  /** 仓级归因（由 useDocumentStore 注入；缺省由服务端按 pageUrl 兜底） */
  repositoryId?: string;
  immediate?: boolean;
}

const EVENT_QUEUE: TelemetryEventPayload[] = [];
const BATCH_SIZE = 10;
const FLUSH_INTERVAL = 10000; // 10 seconds
let telemetryCooldownUntil = 0;

export function trackEvent(payload: TelemetryEventPayload) {
  if (!payload.pageUrl && typeof window !== 'undefined') {
    payload.pageUrl = window.location.pathname;
  }
  if (!payload.repositoryId && typeof window !== 'undefined') {
    payload.repositoryId = useDocumentStore.getState().repositoryId || undefined;
  }
  const isImmediate = payload.immediate;
  delete payload.immediate;

  // Deduplicate monotonic SCROLL_PROGRESS for the same page/target
  if (payload.eventType === 'SCROLL_PROGRESS') {
    const existingIdx = EVENT_QUEUE.findIndex(
      (ev) => ev.eventType === 'SCROLL_PROGRESS' && (ev.targetId === payload.targetId || ev.pageUrl === payload.pageUrl)
    );
    if (existingIdx !== -1) {
      const existing = EVENT_QUEUE[existingIdx];
      const existingPercent = Number(existing.metadata?.scrollPercent ?? 0);
      const newPercent = Number(payload.metadata?.scrollPercent ?? 0);
      EVENT_QUEUE[existingIdx] = {
        ...existing,
        ...payload,
        duration: Math.max(existing.duration ?? 0, payload.duration ?? 0),
        metadata: {
          ...existing.metadata,
          ...payload.metadata,
          scrollPercent: Math.max(existingPercent, newPercent),
        },
      };
      if (isImmediate) flushQueue();
      return;
    }
  }

  EVENT_QUEUE.push(payload);
  if (isImmediate || EVENT_QUEUE.length >= BATCH_SIZE) {
    flushQueue();
  }
}

export function flushQueue() {
  if (EVENT_QUEUE.length === 0) return;
  if (typeof window !== 'undefined' && !isTelemetryAuthenticated()) {
    // Drop telemetry events if unauthenticated to avoid 401 spam
    EVENT_QUEUE.length = 0;
    return;
  }
  if (Date.now() < telemetryCooldownUntil) {
    return;
  }

  const payload = JSON.stringify({
    events: [...EVENT_QUEUE],
  });

  // Clear queue
  EVENT_QUEUE.length = 0;

  // Use fetch with keepalive instead of sendBeacon to ensure cookies are sent
  const endpoint = '/api/telemetry';
  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  })
    .then((res) => {
      if (res.status === 429) {
        // 服务端触发限流，进入 60 秒静默冷却退避，彻底消除控制台 429 刷屏
        telemetryCooldownUntil = Date.now() + 60_000;
        return;
      }
      if (res.ok) {
        // 使用 Zustand 状态中间件统一触发同步，淘汰粗劣的 window CustomEvent 广播
        useReadingProgressStore.getState().triggerSync();
      }
    })
    .catch(() => {
      // 埋点上报失败（服务瞬断或页面关闭）静默兜底，避免控制台产生干扰性红字
    });
}

// 惰性定时器管理：仅在客户端且有事件堆积时运行，消除模块顶层死循环与 HMR 内存泄露
let flushTimer: ReturnType<typeof setInterval> | null = null;

function ensureTimer() {
  if (typeof window === 'undefined' || flushTimer !== null) return;
  flushTimer = setInterval(() => {
    if (EVENT_QUEUE.length > 0) {
      flushQueue();
    }
  }, FLUSH_INTERVAL);
}

// W3C 标准：visibilitychange 必须绑定在 document 上，window 上可能静默失效
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushQueue();
    }
  });
  ensureTimer();
}
