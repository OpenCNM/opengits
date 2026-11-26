import { ignoreBestEffort } from '@/lib/best-effort';
import { MONITOR_QUEUE_CAP, type MonitorBeaconEvent } from './events';
import { isTelemetryAuthenticated } from '@/lib/telemetry/auth-gate';

const BATCH_SIZE = 10;
const FLUSH_INTERVAL = 10000;
const COOLDOWN_MS = 60_000;
const ENDPOINT = '/api/monitor';

const MONITOR_QUEUE: MonitorBeaconEvent[] = [];
let cooldownUntil = 0;

export function trackMonitorEvent(payload: MonitorBeaconEvent): void {
  if (!payload.pageUrl && typeof window !== 'undefined') {
    payload.pageUrl = window.location.pathname;
  }
  const isImmediate = payload.immediate;
  delete payload.immediate;

  if (MONITOR_QUEUE.length >= MONITOR_QUEUE_CAP) {
    MONITOR_QUEUE.shift();
  }
  MONITOR_QUEUE.push(payload);
  if (isImmediate || MONITOR_QUEUE.length >= BATCH_SIZE) {
    flushMonitorQueue();
  }
}

export function flushMonitorQueue(): void {
  if (MONITOR_QUEUE.length === 0) return;
  if (typeof window !== 'undefined' && !isTelemetryAuthenticated()) {
    MONITOR_QUEUE.length = 0;
    return;
  }
  if (Date.now() < cooldownUntil) return;

  const events = MONITOR_QUEUE.map(({ kind, pageUrl, sessionId, severity, payload }) => ({
    kind,
    pageUrl,
    sessionId,
    severity,
    payload,
  }));
  MONITOR_QUEUE.length = 0;

  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
    keepalive: true,
  })
    .then((res) => {
      if (res.status === 429) {
        cooldownUntil = Date.now() + COOLDOWN_MS;
      }
    })
    .catch(ignoreBestEffort);
}

let flushTimer: ReturnType<typeof setInterval> | null = null;

function ensureTimer(): void {
  if (typeof window === 'undefined' || flushTimer !== null) return;
  flushTimer = setInterval(() => {
    if (MONITOR_QUEUE.length > 0) {
      flushMonitorQueue();
    }
  }, FLUSH_INTERVAL);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushMonitorQueue();
    }
  });
  ensureTimer();
}
