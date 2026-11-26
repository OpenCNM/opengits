import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals';
import { trackMonitorEvent } from './transport';
import { STORAGE_KEYS } from '@/lib/constants';
import {
  MONITOR_EVENT_KINDS,
  type MonitorEventKind,
  type MonitorSeverity,
} from './events';

const MESSAGE_TRUNCATE = 2000;
const STACK_TRUNCATE = 8000;
const URL_TRUNCATE = 500;
const USER_AGENT_TRUNCATE = 500;
const FREEZE_SEVERE_MS = 250;
const MAX_FREEZE_PER_SESSION = 20;
const MAX_SAME_ERROR_PER_SESSION = 5;
const FREEZE_DURATION_CAP = 600_000;

const HEARTBEAT_INTERVAL_MS = 30_000;
const CRASH_GRACE_MS = 600_000;
const DRIFT_FREEZE_THRESHOLD_MS = 3_000;

interface TaskAttributionLike {
  containerSrc?: string;
  containerName?: string;
  containerType?: string;
}

interface ScriptTimingLike {
  sourceURL?: string;
  invoker?: string;
}

interface LongAnimationFrameEntryLike {
  duration: number;
  scripts?: ScriptTimingLike[];
}

interface SessionSentinel {
  state: 'running' | 'ended';
  startedAt: number;
  ts: number;
}

let sessionId = '';
let initialized = false;
let sentVitals = false;
let freezeCount = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastHeartbeatAt = 0;
const vitals: Record<string, number> = {};
const errorCounts = new Map<string, number>();

function ensureSession(): string {
  if (!sessionId) {
    sessionId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return sessionId;
}

function track(
  kind: MonitorEventKind,
  opts: { payload?: Record<string, unknown>; severity?: MonitorSeverity; immediate?: boolean } = {},
): void {
  trackMonitorEvent({ channel: 'monitor', kind, sessionId: ensureSession(), ...opts });
}

function truncated(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function throttleKey(kind: string, message: string, stack?: string): string {
  const firstFrame = stack?.split('\n').find((line) => line.trim().startsWith('at ')) ?? '';
  return `${kind}:${message}:${firstFrame}`;
}

function allowError(kind: string, identity: string, stack?: string): boolean {
  const key = throttleKey(kind, identity, stack);
  const seen = errorCounts.get(key) ?? 0;
  if (seen >= MAX_SAME_ERROR_PER_SESSION) return false;
  errorCounts.set(key, seen + 1);
  return true;
}

function sentinelKey(id: string): string {
  return STORAGE_KEYS.MONITOR_SESSION_SENTINEL(id);
}

function readSentinel(key: string): { id: string; value: SessionSentinel } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionSentinel>;
    if (
      (parsed.state !== 'running' && parsed.state !== 'ended') ||
      typeof parsed.ts !== 'number' ||
      typeof parsed.startedAt !== 'number'
    ) {
      return null;
    }
    return {
      id: key.slice(STORAGE_KEYS.MONITOR_SESSION_SENTINEL_PREFIX.length),
      value: { state: parsed.state, startedAt: parsed.startedAt, ts: parsed.ts },
    };
  } catch {
    return null;
  }
}

function writeSentinel(state: SessionSentinel['state']): void {
  try {
    const now = Date.now();
    if (!sentinelStartedAt) sentinelStartedAt = now;
    const payload: SessionSentinel = { state, startedAt: sentinelStartedAt, ts: now };
    localStorage.setItem(sentinelKey(ensureSession()), JSON.stringify(payload));
  } catch {
  }
}

let sentinelStartedAt = 0;

function scanOrphanSentinels(): void {
  try {
    const stale: string[] = [];
    const now = Date.now();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(STORAGE_KEYS.MONITOR_SESSION_SENTINEL_PREFIX)) continue;
      const hit = readSentinel(key);
      if (!hit) {
        stale.push(key);
        continue;
      }
      if (hit.value.state === 'ended') {
        stale.push(key);
        continue;
      }
      if (now - hit.value.ts > CRASH_GRACE_MS) {
        track(MONITOR_EVENT_KINDS.CRASH_INFERRED, {
          payload: {
            previousSessionId: hit.id,
            lastedMs: Math.min(hit.value.ts - hit.value.startedAt, 86_400_000),
          },
          immediate: true,
        });
        stale.push(key);
      }
    }
    for (const key of stale) {
      try {
        localStorage.removeItem(key);
      } catch {
      }
    }
  } catch {
  }
}

function onError(event: ErrorEvent): void {
  const target = event.target;
  if (target instanceof Element && target.tagName) {
    const tagName = target.tagName;
    const url = target.getAttribute('src') || target.getAttribute('href') || '';
    if (!allowError(MONITOR_EVENT_KINDS.RESOURCE_ERROR, `${tagName}:${url}`)) return;
    track(MONITOR_EVENT_KINDS.RESOURCE_ERROR, {
      payload: { tagName, url: truncated(url, URL_TRUNCATE) ?? '' },
    });
    return;
  }

  const message = event.message || 'Unknown script error';
  const stack = truncated(event.error?.stack, STACK_TRUNCATE);
  if (!allowError(MONITOR_EVENT_KINDS.JS_ERROR, message, stack)) return;
  track(MONITOR_EVENT_KINDS.JS_ERROR, {
    payload: {
      message: truncated(message, MESSAGE_TRUNCATE) ?? 'Unknown script error',
      stack,
      source: truncated(event.filename, URL_TRUNCATE),
      line: event.lineno || undefined,
      col: event.colno || undefined,
    },
    immediate: true,
  });
}

function onRejection(event: PromiseRejectionEvent): void {
  const reason: unknown = event.reason;
  const message =
    reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  const stack = truncated(reason instanceof Error ? reason.stack : undefined, STACK_TRUNCATE);
  if (!allowError(MONITOR_EVENT_KINDS.PROMISE_REJECTION, message, stack)) return;
  track(MONITOR_EVENT_KINDS.PROMISE_REJECTION, {
    payload: { message: truncated(message, MESSAGE_TRUNCATE) ?? 'Unknown rejection', stack },
    immediate: true,
  });
}

function reportFreeze(durationMs: number, attribution?: string): void {
  if (freezeCount >= MAX_FREEZE_PER_SESSION) return;
  freezeCount++;
  track(MONITOR_EVENT_KINDS.FREEZE, {
    severity: durationMs >= FREEZE_SEVERE_MS ? 'severe' : 'long',
    payload: {
      durationMs: Math.min(Math.round(durationMs), FREEZE_DURATION_CAP),
      attribution: truncated(attribution, URL_TRUNCATE),
    },
  });
}

function observeFreeze(): void {
  if (typeof PerformanceObserver === 'undefined') return;
  let observer: PerformanceObserver;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if ('scripts' in entry) {
          const loaf = entry as unknown as LongAnimationFrameEntryLike;
          const script = loaf.scripts?.[0];
          reportFreeze(entry.duration, script?.sourceURL || script?.invoker);
        } else if ('attribution' in entry) {
          const attributionTiming =
            (entry as unknown as { attribution?: TaskAttributionLike[] }).attribution?.[0];
          reportFreeze(
            entry.duration,
            attributionTiming?.containerSrc ||
              attributionTiming?.containerName ||
              attributionTiming?.containerType,
          );
        } else {
          reportFreeze(entry.duration);
        }
        if (freezeCount >= MAX_FREEZE_PER_SESSION) {
          observer.disconnect();
          return;
        }
      }
    });
    const supportsLoaf =
      Array.isArray(PerformanceObserver.supportedEntryTypes) &&
      PerformanceObserver.supportedEntryTypes.includes('long-animation-frame');
    observer.observe(
      supportsLoaf
        ? { type: 'long-animation-frame', buffered: true }
        : { type: 'longtask', buffered: true },
    );
  } catch {
  }
}

function observeVitals(): void {
  onLCP((metric) => {
    vitals.lcpMs = metric.value;
  });
  onINP((metric) => {
    vitals.inpMs = metric.value;
  });
  onCLS((metric) => {
    vitals.cls = metric.value;
  });
  onTTFB((metric) => {
    vitals.ttfbMs = metric.value;
  });
  onFCP((metric) => {
    vitals.fcpMs = metric.value;
  });
}

function flushVitals(): void {
  if (sentVitals || Object.keys(vitals).length === 0) return;
  sentVitals = true;
  track(MONITOR_EVENT_KINDS.WEB_VITALS, {
    payload: {
      lcpMs: vitals.lcpMs !== undefined ? Math.round(vitals.lcpMs) : undefined,
      inpMs: vitals.inpMs !== undefined ? Math.round(vitals.inpMs) : undefined,
      cls: vitals.cls !== undefined ? Math.round(vitals.cls * 1000) / 1000 : undefined,
      ttfbMs: vitals.ttfbMs !== undefined ? Math.round(vitals.ttfbMs) : undefined,
      fcpMs: vitals.fcpMs !== undefined ? Math.round(vitals.fcpMs) : undefined,
    },
    immediate: true,
  });
}

function onPageHide(event: PageTransitionEvent): void {
  if (event.persisted) return;
  flushVitals();
  track(MONITOR_EVENT_KINDS.SESSION_END, {
    payload: { reason: 'pagehide' },
    immediate: true,
  });
  writeSentinel('ended');
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') {
    lastHeartbeatAt = Date.now();
  }
}

function onHeartbeat(): void {
  const now = Date.now();
  const drift = now - lastHeartbeatAt - HEARTBEAT_INTERVAL_MS;
  lastHeartbeatAt = now;
  writeSentinel('running');
  if (document.hidden || drift < DRIFT_FREEZE_THRESHOLD_MS) return;
  reportFreeze(drift);
}

export function initMonitorCollector(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  scanOrphanSentinels();
  writeSentinel('running');

  track(MONITOR_EVENT_KINDS.SESSION_START, {
    payload: {
      userAgent: truncated(navigator.userAgent, USER_AGENT_TRUNCATE) ?? '',
    },
  });

  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onRejection);
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibilityChange);
  observeFreeze();
  observeVitals();

  lastHeartbeatAt = Date.now();
  heartbeatTimer = setInterval(onHeartbeat, HEARTBEAT_INTERVAL_MS);
}

