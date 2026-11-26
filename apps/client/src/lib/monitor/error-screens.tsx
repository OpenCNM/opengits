'use client';

import { useEffect } from 'react';
import * as m from '@/paraglide/messages';
import { trackEvent, TELEMETRY_EVENTS } from '@/lib/telemetry/beacon';
import { trackMonitorEvent } from '@/lib/monitor/transport';
import { MONITOR_EVENT_KINDS } from '@/lib/monitor/events';

type RenderError = Error & { digest?: string };

function reportRenderError(error: RenderError, boundary: 'route' | 'global'): void {
  trackEvent({
    eventType: TELEMETRY_EVENTS.CLIENT_ERROR,
    immediate: true,
    metadata: {
      message: error.message,
      digest: error.digest,
      ...(boundary === 'global' ? { level: 'global' as const } : {}),
      stack: error.stack?.slice(0, 500),
    },
  });
  trackMonitorEvent({
    channel: 'monitor',
    kind: MONITOR_EVENT_KINDS.RENDER_ERROR,
    immediate: true,
    payload: {
      message: error.message,
      digest: error.digest,
      stack: error.stack?.slice(0, 8000),
      boundary,
    },
  });
}

export default function RouteErrorScreen({
  error,
  reset,
}: {
  error: RenderError;
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[client-error]', error);
    reportRenderError(error, 'route');
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 px-4 text-center">
      <p className="font-serif text-sm font-bold text-theme-foreground">{m.error_something_went_wrong()}</p>
      <p className="text-xs text-theme-muted">{m.error_retry_desc()}</p>
      <button
        type="button"
        onClick={reset}
        className="px-4 py-1.5 rounded-md bg-theme-primary text-theme-primary-fg text-xs font-bold cursor-pointer hover:opacity-90"
      >{m.common_retry()}</button>
    </div>
  );
}

export function GlobalErrorScreen({
  error,
  reset,
}: {
  error: RenderError;
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[global-error]', error);
    reportRenderError(error, 'global');
  }, [error]);

  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--color-theme-bg, white)',
          color: 'var(--color-theme-foreground, black)',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        }}
      >
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 12, padding: 24 }}>
          <p style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{m.error_page_error()}</p>
          <p style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>{m.error_refresh_hint()}</p>
          <button
            type="button"
            onClick={reset}
            style={{
              alignSelf: 'center',
              padding: '6px 16px',
              borderRadius: 6,
              border: '1px solid currentColor',
              background: 'transparent',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >{m.common_retry()}</button>
        </div>
      </body>
    </html>
  );
}
