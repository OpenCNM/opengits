export const MONITOR_EVENT_KINDS = {
  SESSION_START: 'SESSION_START',
  SESSION_END: 'SESSION_END',
  CRASH_INFERRED: 'CRASH_INFERRED',

  JS_ERROR: 'JS_ERROR',
  RESOURCE_ERROR: 'RESOURCE_ERROR',
  PROMISE_REJECTION: 'PROMISE_REJECTION',
  RENDER_ERROR: 'RENDER_ERROR',

  FREEZE: 'FREEZE',

  WEB_VITALS: 'WEB_VITALS',
} as const;

export type MonitorEventKind = (typeof MONITOR_EVENT_KINDS)[keyof typeof MONITOR_EVENT_KINDS];

export type MonitorSeverity = 'long' | 'severe';

export interface MonitorBeaconEvent {
  channel: 'monitor';
  kind: MonitorEventKind;
  pageUrl?: string;
  sessionId?: string;
  severity?: MonitorSeverity;
  payload?: Record<string, unknown>;
  immediate?: boolean;
}

export const MONITOR_QUEUE_CAP = 100;

export interface SessionStartMetadata {
  userAgent: string;
}

export interface SessionEndMetadata {
  reason: 'pagehide';
}

export interface CrashInferredMetadata {
  previousSessionId: string;
  lastedMs: number;
}

export interface JsErrorMetadata {
  message: string;
  stack?: string;
  source?: string;
  line?: number;
  col?: number;
}

export interface ResourceErrorMetadata {
  tagName: string;
  url: string;
}

export interface PromiseRejectionMetadata {
  message: string;
  stack?: string;
}

export interface RenderErrorMetadata {
  message: string;
  digest?: string;
  stack?: string;
  boundary: 'route' | 'global';
}

export interface FreezeMetadata {
  durationMs: number;
  attribution?: string;
}

export interface WebVitalsMetadata {
  lcpMs?: number;
  inpMs?: number;
  cls?: number;
  ttfbMs?: number;
  fcpMs?: number;
}
