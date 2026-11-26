// Unified Fail-Closed HTTP/stream client for Go worker-sidecar; throws SidecarError on all transport/config/non-2xx failures.

import { ENGINE_CONFIG } from './config';
import { resolveRuntimeEndpoints } from './runtime-endpoints';

export interface SidecarCallOptions {
  label: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  endpoint?: string;
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

async function extractErrorDetail(res: Response): Promise<string> {
  try {
    const errJson = (await res.json()) as { error?: string };
    return errJson.error || '';
  } catch {
    return await res.text().catch(() => '');
  }
}

export async function callSidecar<T>(
  path: string,
  payload: unknown,
  options: SidecarCallOptions
): Promise<T> {
  const runtime = resolveRuntimeEndpoints();
  const endpoint = options.endpoint ?? runtime?.workerSidecar ?? ENGINE_CONFIG.endpoints?.workerSidecar;
  // Missing INTERNAL_API_TOKEN passes empty token so sidecar rejects 403 fail-fast.
  const token = runtime?.internalApiToken ?? process.env.INTERNAL_API_TOKEN ?? '';

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

export async function callSidecarStream(
  path: string,
  payload: unknown,
  options: SidecarCallOptions
): Promise<Response> {
  const runtime = resolveRuntimeEndpoints();
  const endpoint = options.endpoint ?? runtime?.workerSidecar ?? ENGINE_CONFIG.endpoints?.workerSidecar;
  const token = runtime?.internalApiToken ?? process.env.INTERNAL_API_TOKEN ?? '';

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

