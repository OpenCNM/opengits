/**
 * 前端自研监控采集器（模块单例）：错误三源 + 主线程长任务卡死 +
 * Core Web Vitals + 会话生命周期 + 崩溃推断（last-seen-alive）。
 *
 * 由 MonitorInitializer 在客户端挂载时动态 import 初始化（web-vitals 不进首屏包）。
 * 自我限流三层：同源错误每会话上限（错误风暴防爆）、freeze 每会话上限、
 * beacon 队列容量上限（MONITOR_QUEUE_CAP 丢旧保新）。
 * 错误类事件 immediate 直冲（稀有且珍贵）；freeze/vitals 随批量周期上报。
 *
 * 崩溃推断：每会话一条 localStorage 哨兵（running/ended + 心跳 ts）。
 * 新会话加载时扫描孤儿哨兵——停在 running 且心跳超宽限（排除后台标签页
 * 定时器节流与多标签页存活）即判定上一会话崩溃/被杀，补录 CRASH_INFERRED。
 * 所有 localStorage 读写 try/catch 静默兜底（Safari 隐私模式会抛异常，
 * 监控绝不反噬页面）。
 */

import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals';
import { trackMonitorEvent } from './transport';
import { STORAGE_KEYS } from '@/lib/constants';
import {
  MONITOR_EVENT_KINDS,
  type MonitorEventKind,
  type MonitorSeverity,
} from './events';

// 截断/分档常量（与 lib/monitor/schemas.ts 的 Zod 上限双侧一致）
const MESSAGE_TRUNCATE = 2000;
const STACK_TRUNCATE = 8000;
const URL_TRUNCATE = 500;
const USER_AGENT_TRUNCATE = 500;
const FREEZE_SEVERE_MS = 250;
const MAX_FREEZE_PER_SESSION = 20;
const MAX_SAME_ERROR_PER_SESSION = 5;
const FREEZE_DURATION_CAP = 600_000; // Zod 上限对齐（系统休眠唤醒的巨幅漂移截断）

// 心跳与崩溃推断参数
const HEARTBEAT_INTERVAL_MS = 30_000;
// 崩溃判定宽限：Chrome 后台标签页密集节流下心跳最稀 ~1 次/分钟，
// 10 分钟宽限确保存活标签页绝不误判（代价：崩溃确认延迟 ≥10 分钟）
const CRASH_GRACE_MS = 600_000;
// 事件循环漂移阈值：单 tick 实际延迟超出设定 3s = 主线程被占死
const DRIFT_FREEZE_THRESHOLD_MS = 3_000;

/** Long Task / LoAF 归因（TS DOM lib 尚未内置这两组类型，按 W3C 规约最小声明） */
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

/** localStorage 哨兵负载 */
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
/** 同源错误节流计数（客户端粗粒度；服务端指纹负责精确聚合） */
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

/** 节流键：kind + message + 首帧（行号漂移在键空间内自然归并） */
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

// ── 崩溃推断哨兵（localStorage，全部静默容错）──

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
    // 隐私模式/配额满：崩溃推断退化为不可用，其余采集不受影响
  }
}

let sentinelStartedAt = 0;

/**
 * 扫描孤儿哨兵：running 且心跳超宽限 → 崩溃推断补录；ended/无法解析 → 回收。
 * 多标签页安全：存活标签页由心跳保活 ts，绝不落入宽限窗口。
 */
function scanOrphanSentinels(): void {
  try {
    const stale: string[] = [];
    const now = Date.now();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(STORAGE_KEYS.MONITOR_SESSION_SENTINEL_PREFIX)) continue;
      const hit = readSentinel(key);
      if (!hit) {
        stale.push(key); // 解析失败的哨兵直接回收
        continue;
      }
      if (hit.value.state === 'ended') {
        stale.push(key); // 善终哨兵：崩溃判定已完成，回收
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
      // running 且心跳新鲜：其他标签页存活，保留
    }
    for (const key of stale) {
      try {
        localStorage.removeItem(key);
      } catch {
        // 回收失败不中断（下轮扫描重试）
      }
    }
  } catch {
    // localStorage 不可访问：静默跳过
  }
}

// ── 错误三源 ──

function onError(event: ErrorEvent): void {
  // capture 阶段：资源加载失败（script/img/css）的 target 是元素而非 window
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

// ── 卡死：LoAF 优先（带脚本归因），longtask 兜底（≥50ms 记录，≥250ms 严重）──

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
          // LoAF：归因到贡献最大的脚本源
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
    // LoAF 归因比 longtask 丰富（能定位脚本源）；仅 LoAF 缺席时回落 longtask
    const supportsLoaf =
      Array.isArray(PerformanceObserver.supportedEntryTypes) &&
      PerformanceObserver.supportedEntryTypes.includes('long-animation-frame');
    observer.observe(
      supportsLoaf
        ? { type: 'long-animation-frame', buffered: true }
        : { type: 'longtask', buffered: true },
    );
  } catch {
    // 两类 entry 均不支持的浏览器：仅剩事件循环漂移心跳兜底
  }
}

// ── 性能：Core Web Vitals 逐指标缓存最新值，会话善终时一条聚合事件 ──

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

// ── 会话生命周期 + 心跳 ──

function onPageHide(event: PageTransitionEvent): void {
  if (event.persisted) return; // bfcache：会话将在恢复后继续，不写善终
  flushVitals();
  track(MONITOR_EVENT_KINDS.SESSION_END, {
    payload: { reason: 'pagehide' },
    immediate: true,
  });
  writeSentinel('ended');
}

function onVisibilityChange(): void {
  // 隐藏→可见：漂移基线重置（后台定时器节流不是卡死，防误报）
  if (document.visibilityState === 'visible') {
    lastHeartbeatAt = Date.now();
  }
}

/**
 * 心跳 tick：哨兵保活（崩溃推断的 last-seen）+ 事件循环漂移检测
 * （PerformanceObserver 双 entry 均缺席的浏览器上的卡死兜底）。
 * 隐藏状态下跳过漂移判定（浏览器主动节流定时器，非主线程阻塞）。
 */
function onHeartbeat(): void {
  const now = Date.now();
  const drift = now - lastHeartbeatAt - HEARTBEAT_INTERVAL_MS;
  lastHeartbeatAt = now;
  writeSentinel('running');
  if (document.hidden || drift < DRIFT_FREEZE_THRESHOLD_MS) return;
  reportFreeze(drift);
}

// ── 初始化入口（幂等；React StrictMode 双挂载安全）──

export function initMonitorCollector(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  // 1. 崩溃推断：先扫孤儿哨兵（补录上一会话），再登记本会话
  scanOrphanSentinels();
  writeSentinel('running');

  // 2. 会话开始事件
  track(MONITOR_EVENT_KINDS.SESSION_START, {
    payload: {
      userAgent: truncated(navigator.userAgent, USER_AGENT_TRUNCATE) ?? '',
    },
  });

  // 3. 监听器与观察器
  window.addEventListener('error', onError, true); // capture 阶段是资源错误的唯一捕获途径
  window.addEventListener('unhandledrejection', onRejection);
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibilityChange);
  observeFreeze();
  observeVitals();

  // 4. 心跳（哨兵保活 + 漂移兜底）
  lastHeartbeatAt = Date.now();
  heartbeatTimer = setInterval(onHeartbeat, HEARTBEAT_INTERVAL_MS);
}

