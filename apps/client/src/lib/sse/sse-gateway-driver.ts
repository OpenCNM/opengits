import { NextResponse } from 'next/server';
import { ENGINE_CONFIG } from '@/lib/config';

/**
 * ─────────────────────────────────────────────────────────────
 * 全站 SSE 广播网关（Go 原生 services/worker-sidecar :8082）TS 分发驱动。
 *
 * 职责：
 * 1. 长连接由 Go 原生网关独占（Fail-Closed，杜绝本地 Node 双轨回退与内存泄露）；
 * 2. 负责透传 Last-Event-ID、Session Cookie、Authorization 头与查询参数；
 * 3. 注入微服务零信任内部凭证 x-internal-token 与 x-user-id。
 * ─────────────────────────────────────────────────────────────
 */

export function sseGatewayEnabled(): boolean {
  return Boolean(ENGINE_CONFIG.endpoints.sseGateway);
}
export interface ForwardSseOptions {
  userId?: string | null;
}

export async function forwardSse(
  req: Request,
  pathname: string,
  options?: ForwardSseOptions
): Promise<NextResponse> {
  const endpoint = ENGINE_CONFIG.endpoints.sseGateway;
  if (!endpoint) {
    return new NextResponse('SSE Gateway is not configured (Fail-Closed)', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const rawUrl = new URL(req.url);
  const gatewayBase = endpoint.replace(/\/+$/, '');
  const targetUrl = new URL(`${gatewayBase}${pathname}`);
  targetUrl.search = rawUrl.search;

  const forwardHeaders = new Headers();
  const cookie = req.headers.get('cookie');
  if (cookie) forwardHeaders.set('cookie', cookie);

  const auth = req.headers.get('authorization');
  if (auth) forwardHeaders.set('authorization', auth);

  const lastEventId = req.headers.get('last-event-id');
  if (lastEventId) forwardHeaders.set('last-event-id', lastEventId);

  forwardHeaders.set('accept', 'text/event-stream');

  const internalToken = process.env.INTERNAL_API_TOKEN;
  if (internalToken) {
    forwardHeaders.set('x-internal-token', internalToken);
  }
  if (options?.userId) {
    forwardHeaders.set('x-user-id', options.userId);
  }

  const isPost = req.method === 'POST';
  const body = isPost ? await req.clone().text() : undefined;

  try {
    const res = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: forwardHeaders,
      body,
      signal: req.signal,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => 'SSE Gateway Error');
      return new NextResponse(errorText, {
        status: res.status,
        headers: {
          'Content-Type': res.headers.get('content-type') || 'text/plain',
        },
      });
    }

    return new NextResponse(res.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    if (req.signal.aborted) {
      throw err;
    }
    console.error(`[sse-gateway] Failed to connect to Go SSE Gateway (${targetUrl}):`, err);
    return new NextResponse('SSE Gateway Unavailable (Fail-Closed)', {
      status: 502,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

