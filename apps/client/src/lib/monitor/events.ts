/**
 * 前端自研监控事件契约 (Monitor Event Registry & Contracts)
 *
 * 与 TELEMETRY_EVENTS（产品旅程分析，落 EpisodicEvent）刻意分流：
 * 本注册表面向运维排障（报错/卡死/性能），经 beacon 队列 monitor 通道
 * 上报 /api/monitor，由 Go worker-sidecar /v1/monitor/events 单写者落 MonitorEvent。
 *
 * 三元组同步：prisma/schema.prisma#MonitorEvent ↔ ./schemas.ts (Zod 网关)
 * ↔ 本注册表；Go 侧 allowedMonitorEventKinds 由 tests/unit/monitor-kinds.test.ts 守护。
 */

export const MONITOR_EVENT_KINDS = {
  // 会话生命周期（pagehide 善终；未善终由哨兵+心跳推断为崩溃）
  SESSION_START: 'SESSION_START',
  SESSION_END: 'SESSION_END',
  CRASH_INFERRED: 'CRASH_INFERRED',

  // 错误三源 + 渲染边界（Error Boundary 接不住的回调/Promise 链由前两者兜底）
  JS_ERROR: 'JS_ERROR',
  RESOURCE_ERROR: 'RESOURCE_ERROR',
  PROMISE_REJECTION: 'PROMISE_REJECTION',
  RENDER_ERROR: 'RENDER_ERROR',

  // 卡死（主线程长任务；LoAF 归因与事件循环漂移心跳 P2 接入）
  FREEZE: 'FREEZE',

  // 性能（Core Web Vitals，会话善终时一条聚合事件）
  WEB_VITALS: 'WEB_VITALS',
} as const;

export type MonitorEventKind = (typeof MONITOR_EVENT_KINDS)[keyof typeof MONITOR_EVENT_KINDS];

/** freeze 事件分档：≥50ms 记录，≥250ms 严重 */
export type MonitorSeverity = 'long' | 'severe';

/** beacon 队列的 monitor 通道事件（channel 字段驱动 flushQueue 分流） */
export interface MonitorBeaconEvent {
  channel: 'monitor';
  kind: MonitorEventKind;
  pageUrl?: string;
  sessionId?: string;
  severity?: MonitorSeverity;
  payload?: Record<string, unknown>;
  /** 立即冲刷（错误/会话善终用；发送前剥离，不出网） */
  immediate?: boolean;
}

/** monitor 队列容量上限：错误风暴下丢旧保新，防内存与网络双爆 */
export const MONITOR_QUEUE_CAP = 100;

// ── kind 专属结构化负载（./schemas.ts Zod 契约的 TS 对偶）──

export interface SessionStartMetadata {
  userAgent: string;
}

export interface SessionEndMetadata {
  reason: 'pagehide';
}

/** 崩溃推断：上一会话哨兵停在 running 且心跳超宽限（last-seen-alive 模式） */
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
