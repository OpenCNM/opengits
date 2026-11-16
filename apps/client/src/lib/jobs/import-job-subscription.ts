/**
 * ImportJob 客户端订阅（Phase B）：可续传 SSE 优先，轮询快照兜底。
 *
 * 设计：
 * - EventSource 原生自动重连 + Last-Event-ID 续传（浏览器自带，零恢复代码）；
 * - 重连放弃（readyState CLOSED，如 404/401）或环境无 EventSource 时，
 *   切换到 2s 快照轮询（?since=<游标> 增量拉取），用户无感；
 * - 服务端在终态缺尾事件时（reap 兜底）会合成 done/error，本端只转发事件流。
 * 本模块浏览器专用（客户端组件引用），零服务端依赖。
 */

export interface ImportJobEventData {
  type: string;
  message?: string;
  chunk?: string;
  [key: string]: unknown;
}

export interface ImportJobSubscription {
  stop: () => void;
}

/** 轮询降级间隔：跨境烂网络下短请求友好（数据中心内即回） */
const POLL_FALLBACK_MS = 2000;

export function subscribeImportJob(
  jobId: string,
  handlers: {
    onEvent: (data: ImportJobEventData) => void;
    /** 流终结（终态/中止/任务消失）；reason 供调用方区分静默中止与失败 */
    onClose: (reason: 'terminal' | 'aborted' | 'gone') => void;
  },
  signal?: AbortSignal
): ImportJobSubscription {
  let stopped = false;
  let cursor = -1;
  let es: EventSource | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const onAbort = () => {
    if (stopped) return;
    stop();
    handlers.onClose('aborted');
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener('abort', onAbort);
    es?.close();
    es = null;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  // 已中止的 signal 不会再触发 abort 事件——前置检查防僵尸订阅
  if (signal?.aborted) {
    handlers.onClose('aborted');
    return { stop: () => undefined };
  }

  signal?.addEventListener('abort', onAbort);

  const startPolling = () => {
    if (stopped || pollTimer) return;
    const tick = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/ingest-jobs/${jobId}?since=${cursor}`, {
          cache: 'no-store',
        });
        if (res.status === 404) {
          stop();
          handlers.onClose('gone');
          return;
        }
        if (!res.ok) return; // 瞬时错误：下轮重试
        const snapshot = await res.json();
        for (const ev of snapshot.events || []) {
          cursor = ev.seq;
          handlers.onEvent({ type: ev.type, ...(ev.payload || {}) });
        }
        const status: string = snapshot.job?.status;
        const terminal =
          status === 'COMPLETED' || status === 'FAILED';
        if (terminal) {
          // 服务端合成兜底之外的最后防线：终态但未见 done/error 事件
          const sawTerminal = (snapshot.events || []).some(
            (ev: { type: string }) => ev.type === 'done' || ev.type === 'error'
          );
          if (!sawTerminal) {
            handlers.onEvent(
              status === 'COMPLETED'
                ? { type: 'done', message: 'Ingestion complete' }
                : { type: 'error', message: snapshot.job?.error || '导入任务失败' }
            );
          }
          stop();
          handlers.onClose('terminal');
        }
      } catch {
        // 网络抖动：等下一轮
      }
    };
    void tick();
    pollTimer = setInterval(() => void tick(), POLL_FALLBACK_MS);
  };

  if (typeof window !== 'undefined' && typeof window.EventSource !== 'undefined') {
    es = new EventSource(`/api/ingest-jobs/${jobId}/events`);
    es.onmessage = (msg: MessageEvent) => {
      // lastEventId 即服务端 `id: <seq>`（合成事件不带 id，游标不前进）
      const id = Number(msg.lastEventId);
      if (Number.isFinite(id)) cursor = Math.max(cursor, id);
      try {
        const data = JSON.parse(msg.data);
        handlers.onEvent(data);
        // 终态即主动停订阅：服务端关流是正常结束，但浏览器 EventSource 会把
        // 关流当断线无限自动重连（每 ~3s 一轮，直到页面卸载）——必须显式 close
        if (data && (data.type === 'done' || data.type === 'error')) {
          stop();
          handlers.onClose('terminal');
        }
      } catch {
        // 非 JSON 帧：忽略（心跳注释行不会进 onmessage）
      }
    };
    es.onerror = () => {
      // CONNECTING = 浏览器原生重连中（Last-Event-ID 自动续传），不打扰；
      // CLOSED = 重连放弃（404/401/致命错），降级轮询
      if (es && es.readyState === EventSource.CLOSED && !stopped) {
        es.close();
        es = null;
        startPolling();
      }
    };
  } else {
    startPolling();
  }

  return { stop };
}
