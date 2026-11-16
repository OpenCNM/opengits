/**
 * 前端监控插件自有传输层：队列 + 批量冲刷纪律（10 条/10s/keepalive/
 * visibilitychange 冲刷/429 冷却退避/未登录丢弃），与 journey beacon 的
 * 冲刷纪律对齐但代码归插件所有——beacon 对本模块的存在零感知
 * （依赖方向：monitor → auth-gate 单向，业务传输层零污染）。
 */

import { MONITOR_QUEUE_CAP, type MonitorBeaconEvent } from './events';
import { isTelemetryAuthenticated } from '@/lib/telemetry/auth-gate';

const BATCH_SIZE = 10;
const FLUSH_INTERVAL = 10000; // 10s：与 journey beacon 同拍
const COOLDOWN_MS = 60_000; // 429 后静默冷却，消除控制台刷屏
const ENDPOINT = '/api/monitor';

const MONITOR_QUEUE: MonitorBeaconEvent[] = [];
let cooldownUntil = 0;

/**
 * 监控事件入口（错误/卡死/性能/会话生命周期）。
 * 队列达 MONITOR_QUEUE_CAP 丢旧保新（错误风暴防爆）。
 */
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
  // 未登录丢弃（v1 仅登录态监控），防 401 噪音——与 journey 通道同纪律
  if (typeof window !== 'undefined' && !isTelemetryAuthenticated()) {
    MONITOR_QUEUE.length = 0;
    return;
  }
  if (Date.now() < cooldownUntil) return;

  // channel/immediate 为本地字段，出网前剥离
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
    .catch(() => {
      // 上报失败静默兜底（服务瞬断或页面关闭），监控绝不反噬页面
    });
}

// 惰性定时器 + W3C 标准的 document visibilitychange 冲刷（纪律与 beacon 一致）
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
