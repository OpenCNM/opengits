export interface ImportJobEventData {
  type: string;
  message?: string;
  chunk?: string;
  [key: string]: unknown;
}

export interface ImportJobSubscription {
  stop: () => void;
}

const POLL_FALLBACK_MS = 2000;

export function subscribeImportJob(
  jobId: string,
  handlers: {
    onEvent: (data: ImportJobEventData) => void;
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
        if (!res.ok) return;
        const snapshot = await res.json();
        for (const ev of snapshot.events || []) {
          cursor = ev.seq;
          handlers.onEvent({ type: ev.type, ...(ev.payload || {}) });
        }
        const status: string = snapshot.job?.status;
        const terminal =
          status === 'COMPLETED' || status === 'FAILED';
        if (terminal) {
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
      }
    };
    void tick();
    pollTimer = setInterval(() => void tick(), POLL_FALLBACK_MS);
  };

  if (typeof window !== 'undefined' && typeof window.EventSource !== 'undefined') {
    es = new EventSource(`/api/ingest-jobs/${jobId}/events`);
    es.onmessage = (msg: MessageEvent) => {
      const id = Number(msg.lastEventId);
      if (Number.isFinite(id)) cursor = Math.max(cursor, id);
      try {
        const data = JSON.parse(msg.data);
        handlers.onEvent(data);
        if (data && (data.type === 'done' || data.type === 'error')) {
          stop();
          handlers.onClose('terminal');
        }
      } catch {
      }
    };
    es.onerror = () => {
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
