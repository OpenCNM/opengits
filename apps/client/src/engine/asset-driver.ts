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

    console.warn(`[asset-driver] sidecar returned non-actionable status ${res.status}, falling back to Node`);
    return null;
  } catch (err) {
    console.warn(`[asset-driver] sidecar unreachable (${(err as Error)?.message || err}), falling back to Node`);
    return null;
  }
}

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
