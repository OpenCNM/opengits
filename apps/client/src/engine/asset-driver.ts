/**
 * apps/client/src/engine/asset-driver.ts
 *
 * 静态资产与图片流式直出驱动（TypeScript 衔接 Go worker-sidecar）。
 *
 * 架构不变式（2026-09-14 资产下沉）：
 * 1. Zero-Buffer Pipe：通过底层 Web Stream Pipe（new Response(sidecarRes.body)）
 *    直接流式透传 Go worker-sidecar 原生响应，绝不在 Node V8 堆内存中调用
 *    .arrayBuffer() 或 .buffer() 分配内存，彻底消灭 GC 尖峰；
 * 2. 原生支持 HTTP 206 Range 与 304 协商缓存：
 *    透传 Range、If-Range、If-Modified-Since、If-None-Match、If-Match 等请求头，
 *    透传 Content-Range、Accept-Ranges、ETag、Last-Modified、Cache-Control 等响应头；
 * 3. 规范支持 CDN 302 重定向直出（redirect: 'manual' 避免 Node 内部跟从，零损耗直达客户端浏览器）；
 * 4. Fail-Open 优雅降级：
 *    若 worker-sidecar 离线、未配置或返回 5xx 故障，返回 null，
 *    调用方透明无缝降级至 Node 原生读取与回源逻辑，保障业务 100% 高可用。
 */

import { ENGINE_CONFIG, CACHE_CONTROL_STRATEGIES } from '../lib/config';

interface SidecarAssetServeParams {
  owner: string;
  repo: string;
  path: string;
  sha?: string | null;
  branch?: string | null;
  method?: string;
  headers?: Headers | Record<string, string | string[] | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  endpoint?: string;
}

const FORWARDED_REQ_HEADERS = [
  'range',
  'if-range',
  'if-modified-since',
  'if-none-match',
  'if-match',
  'if-unmodified-since',
] as const;

/**
 * 请求 Go worker-sidecar 流式资产服务（GET /v1/assets/serve）。
 * 若 sidecar 离线或不可达，返回 null（Fail-Open 语义）；
 * 若命中资产、302重定向、或确定客户端错误（400/404），返回 Response 对象。
 */
export async function executeSidecarAssetServe(
  params: SidecarAssetServeParams
): Promise<Response | null> {
  const endpoint = params.endpoint ?? ENGINE_CONFIG.endpoints?.workerSidecar;
  const token = process.env.INTERNAL_API_TOKEN;

  if (!endpoint || !token) {
    return null;
  }

  const base = endpoint.replace(/\/+$/, '');
  const url = new URL(`${base}/v1/assets/serve`);
  url.searchParams.set('owner', params.owner);
  url.searchParams.set('repo', params.repo);
  url.searchParams.set('path', params.path);
  if (params.sha) url.searchParams.set('sha', params.sha);
  if (params.branch) url.searchParams.set('branch', params.branch);

  const reqHeaders: Record<string, string> = {
    'x-internal-token': token,
  };

  if (params.headers) {
    if (typeof (params.headers as Headers).get === 'function') {
      const h = params.headers as Headers;
      for (const name of FORWARDED_REQ_HEADERS) {
        const val = h.get(name);
        if (val) reqHeaders[name] = val;
      }
    } else {
      const h = params.headers as Record<string, string | string[] | undefined>;
      for (const name of FORWARDED_REQ_HEADERS) {
        const val = h[name];
        if (val !== undefined && val !== null) {
          reqHeaders[name] = Array.isArray(val) ? val.join(', ') : String(val);
        }
      }
    }
  }

  const timeoutMs = params.timeoutMs ?? 15_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = params.signal
    ? AbortSignal.any([params.signal, timeoutSignal])
    : timeoutSignal;

  try {
    const res = await fetch(url.toString(), {
      method: params.method ?? 'GET',
      headers: reqHeaders,
      signal,
      redirect: 'manual',
    });

    // 200 (OK), 206 (Partial Content), 304 (Not Modified), 301/302 (Redirect), 400 (Bad Request), 404 (Not Found) 是确定性业务结果
    if (
      res.status === 200 ||
      res.status === 206 ||
      res.status === 304 ||
      res.status === 301 ||
      res.status === 302 ||
      res.status === 400 ||
      res.status === 404
    ) {
      return res;
    }

    // 非预期状态码（如 5xx、401、502）记录日志并 Fail-Open 降级
    console.warn(`[asset-driver] sidecar returned non-actionable status ${res.status}, falling back to Node`);
    return null;
  } catch (err) {
    // 捕获所有连接拒绝、超时等异常，实现 Fail-Open
    console.warn(`[asset-driver] sidecar unreachable (${(err as Error)?.message || err}), falling back to Node`);
    return null;
  }
}

/**
 * 将 Go sidecar 的资产响应通过零拷贝 Stream Pipe 管道转发给客户端。
 * 绝不在 Node V8 堆内存中分配 Buffer。
 */
export function pipeSidecarAssetResponse(
  sidecarRes: Response,
  extraHeaders?: Record<string, string>
): Response {
  const headers = new Headers();
  const forwardedHeaderNames = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
    'cache-control',
    'x-content-type-options',
    'location',
    'x-ogis-version',
    'x-ogis-gitsha',
  ];

  for (const name of forwardedHeaderNames) {
    const val = sidecarRes.headers.get(name);
    if (val !== null) {
      headers.set(name, val);
    }
  }

  // 确保 2xx 与 304 响应基础缓存策略与安全头完备
  if (sidecarRes.status < 300 || sidecarRes.status === 304) {
    if (!headers.has('cache-control')) {
      headers.set('cache-control', CACHE_CONTROL_STRATEGIES.immutableAssets);
    }
    if (!headers.has('x-content-type-options')) {
      headers.set('x-content-type-options', 'nosniff');
    }
  }

  if (extraHeaders) {
    for (const [key, val] of Object.entries(extraHeaders)) {
      if (val !== undefined && val !== null) {
        headers.set(key, val);
      }
    }
  }

  // 304 Not Modified, 204 No Content, 301 Moved, 302 Found 不应透传响应体
  if (
    sidecarRes.status === 304 ||
    sidecarRes.status === 204 ||
    sidecarRes.status === 301 ||
    sidecarRes.status === 302
  ) {
    return new Response(null, {
      status: sidecarRes.status,
      statusText: sidecarRes.statusText,
      headers,
    });
  }

  return new Response(sidecarRes.body, {
    status: sidecarRes.status,
    statusText: sidecarRes.statusText,
    headers,
  });
}
