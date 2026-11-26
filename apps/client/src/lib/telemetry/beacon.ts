import { ignoreBestEffort } from '@/lib/best-effort';
import { TELEMETRY_EVENTS, type TelemetryEventType } from './events';
import { useDocumentStore } from '@/lib/stores/document-store';
import { useReadingProgressStore } from '@/lib/stores/reading-progress-store';
import { isTelemetryAuthenticated, setTelemetryAuthenticated } from './auth-gate';

export { TELEMETRY_EVENTS, type TelemetryEventType };
export type * from './events';
export { setTelemetryAuthenticated };

export interface TelemetryEventPayload {
  eventType: TelemetryEventType;
  pageUrl?: string;
  targetId?: string;
  duration?: number;
  metadata?: Record<string, any>;
  repositoryId?: string;
  immediate?: boolean;
}

const EVENT_QUEUE: TelemetryEventPayload[] = [];
const BATCH_SIZE = 10;
const FLUSH_INTERVAL = 10000;
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
    EVENT_QUEUE.length = 0;
    return;
  }
  if (Date.now() < telemetryCooldownUntil) {
    return;
  }

  const payload = JSON.stringify({
    events: [...EVENT_QUEUE],
  });

  EVENT_QUEUE.length = 0;

  const endpoint = '/api/telemetry';
  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  })
    .then((res) => {
      if (res.status === 429) {
        telemetryCooldownUntil = Date.now() + 60_000;
        return;
      }
      if (res.ok) {
        useReadingProgressStore.getState().triggerSync();
      }
    })
    .catch(ignoreBestEffort);
}

let flushTimer: ReturnType<typeof setInterval> | null = null;

function ensureTimer() {
  if (typeof window === 'undefined' || flushTimer !== null) return;
  flushTimer = setInterval(() => {
    if (EVENT_QUEUE.length > 0) {
      flushQueue();
    }
  }, FLUSH_INTERVAL);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushQueue();
    }
  });
  ensureTimer();
}
