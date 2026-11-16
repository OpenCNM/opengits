/**
 * apps/client/src/lib/sidecar-client.ts
 *
 * Go worker-sidecar 统一 JSON-RPC 客户端（所有 TS driver 的唯一传输层）。
 *
 * 架构不变式（2026-09-11 收刀终态）：
 * 1. 统一收口 endpoint 解析、INTERNAL_API_TOKEN 鉴权、超时守卫与错误详情解析，
 *    消除各 driver 重复手写 fetch 样板；
 * 2. 全仓单语义 Fail-Closed：任何失败（缺配置、超时、网络错误、非 2xx）抛
 *    SidecarError——本地 TS 降级双轨已全量物理删除（A/B/C 组收刀），
 *    修复动作一律在 Go 端。
 */

import { ENGINE_CONFIG } from './config';

export interface SidecarCallOptions {
  /** 调用标签，用于错误信息与降级观测日志（如 "chunker /v1/chunk/markdown"）。 */
  label: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 缺省取 ENGINE_CONFIG.endpoints.workerSidecar。 */
  endpoint?: string;
  /** 自定义请求头（如 Accept: text/event-stream）。 */
  headers?: Record<string, string>;
}

export class SidecarError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'SidecarError';
  }
}

/** 解析 sidecar 错误响应体中的 { error } 详情（尽力而为，失败回落纯文本）。 */
async function extractErrorDetail(res: Response): Promise<string> {
  try {
    const errJson = (await res.json()) as { error?: string };
    return errJson.error || '';
  } catch {
    return await res.text().catch(() => '');
  }
}

/**
 * Fail-Closed 调用：任何失败（缺配置、超时、网络错误、非 2xx）均抛出 SidecarError。
 */
export async function callSidecar<T>(
  path: string,
  payload: unknown,
  options: SidecarCallOptions
): Promise<T> {
  // endpoints 用 ?. 容错：配置被部分替换/残缺时按「未配置」处理抛 SidecarError
  // （Fail-Closed 终态——本地降级路径已于 2026-09-11 收刀物理删除）。
  const endpoint = options.endpoint ?? ENGINE_CONFIG.endpoints?.workerSidecar;
  // 内部令牌只来自 env（dev.js / compose 注入）；缺失即以空令牌请求，由 sidecar 403 拒绝（fail-fast）
  const token = process.env.INTERNAL_API_TOKEN || '';

  if (!endpoint) {
    throw new SidecarError(
      `${options.label}: ENGINE_CONFIG sidecar endpoint is not configured`
    );
  }
  if (!token) {
    throw new SidecarError(
      `${options.label}: INTERNAL_API_TOKEN is not configured for worker sidecar authentication`
    );
  }

  const timeoutMs = options.timeoutMs ?? 10_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const base = endpoint.replace(/\/+$/, '');

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': token,
        ...(options.headers || {}),
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new SidecarError(
      `${options.label}: sidecar unreachable (${(err as Error)?.message || err})`,
      undefined,
      err
    );
  }

  if (!res.ok) {
    const detail = await extractErrorDetail(res);
    throw new SidecarError(
      `${options.label} failed (HTTP ${res.status}): ${detail || res.statusText}`,
      res.status
    );
  }

  return (await res.json()) as T;
}

/**
 * Fail-Closed 流式调用：向 Go worker-sidecar 发起流式请求并返回未消费的 Response。
 * 响应 body 可直接作为 Native Web Stream 透传，实现零 V8 堆内存开销。
 */
export async function callSidecarStream(
  path: string,
  payload: unknown,
  options: SidecarCallOptions
): Promise<Response> {
  const endpoint = options.endpoint ?? ENGINE_CONFIG.endpoints?.workerSidecar;
  // 内部令牌只来自 env（dev.js / compose 注入）；缺失即以空令牌请求，由 sidecar 403 拒绝（fail-fast）
  const token = process.env.INTERNAL_API_TOKEN || '';

  if (!endpoint) {
    throw new SidecarError(
      `${options.label}: ENGINE_CONFIG sidecar endpoint is not configured`
    );
  }
  if (!token) {
    throw new SidecarError(
      `${options.label}: INTERNAL_API_TOKEN is not configured for worker sidecar authentication`
    );
  }

  const timeoutMs = options.timeoutMs ?? 60_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const base = endpoint.replace(/\/+$/, '');

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': token,
        ...(options.headers || {}),
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new SidecarError(
      `${options.label}: sidecar unreachable (${(err as Error)?.message || err})`,
      undefined,
      err
    );
  }

  if (!res.ok) {
    const detail = await extractErrorDetail(res);
    throw new SidecarError(
      `${options.label} failed (HTTP ${res.status}): ${detail || res.statusText}`,
      res.status
    );
  }

  return res;
}

