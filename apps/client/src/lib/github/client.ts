import { ignoreBestEffort } from '../best-effort';
import { tokenFingerprint, acquirePoolToken, markTokenCooldown, markTokenQuarantined, poolStats } from './token-pool';
import { resolveGithubToken } from '../github/token-resolver';

export type GithubEndpointClass = 'api-core' | 'raw' | 'archive' | 'search';

export interface GithubFetchOptions {
  userId?: string | null;
  explicitToken?: string;
  endpointClass?: GithubEndpointClass;
}

let callCounter = 0;

const TRANSIENT_FETCH_PATTERN =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_|socket|terminated|network/i;

export class GithubNetworkError extends Error {
  constructor(attempts: number, cause: unknown) {
    super(`连接 GitHub 失败（网络中断或代理不可用），已尝试 ${attempts} 次仍失败，请检查网络后重试`);
    this.name = 'GithubNetworkError';
    this.cause = cause;
  }
}

function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (TRANSIENT_FETCH_PATTERN.test(err.message)) return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause !== undefined && cause !== null && TRANSIENT_FETCH_PATTERN.test(String(cause));
}

function mergeHeaders(init: RequestInit | undefined, token: string | undefined): Headers {
  const headers = new Headers(init?.headers ?? {});
  headers.set('User-Agent', headers.get('User-Agent') || 'OpenGits-Engine/1.0');
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  } else {
    headers.delete('Authorization');
  }
  return headers;
}

function parseReset(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const sec = Number(headerValue);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : undefined;
}

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const sec = Number(headerValue);
  return Number.isFinite(sec) && sec > 0 ? (sec + Math.floor(Date.now() / 1000)) * 1000 : undefined;
}

function isRateLimited(
  status: number,
  remainingHeader: string | null,
  res: Response,
  endpointClass?: GithubEndpointClass
): boolean {
  if (status === 429) return true;
  if (remainingHeader !== null && Number(remainingHeader) === 0) return true;
  if (status === 403 && (res.headers.get('retry-after') !== null || res.headers.get('x-ratelimit-remaining') === '0')) return true;
  if (endpointClass === 'raw' && (status === 403 || status === 429)) return true;
  return false;
}

async function sampleQuota(entry: {
  fingerprint: string;
  remaining: number;
  resetAt: Date | null;
  endpointClass: GithubEndpointClass;
  status: number;
}): Promise<void> {
  callCounter += 1;
  if (!Number.isFinite(entry.remaining)) return;
  const sampled = callCounter % 10 === 0 || entry.remaining < 200;
  if (!sampled) return;
  try {
    const { callSidecar } = await import('@/lib/sidecar-client');
    const res = callSidecar<{ ok: boolean }>(
      '/v1/github/quota/sample',
      {
        fingerprint: entry.fingerprint,
        remaining: entry.remaining,
        resetAt: entry.resetAt ? entry.resetAt.toISOString() : null,
        endpointClass: entry.endpointClass,
        status: entry.status,
      },
      { label: 'github-client' }
    );
    if (res && typeof res.catch === 'function') {
      res.catch(ignoreBestEffort);
    }
  } catch {
    ignoreBestEffort();
  }
}

export async function githubFetch(
  url: string,
  init: RequestInit = {},
  opts: GithubFetchOptions = {}
): Promise<Response> {
  const endpointClass = opts.endpointClass ?? 'api-core';
  const method = (init.method || 'GET').toUpperCase();

  let token: string | undefined;
  let fingerprint: string;
  if (opts.explicitToken) {
    token = opts.explicitToken;
    fingerprint = tokenFingerprint(token);
  } else if (opts.userId) {
    token = await resolveGithubToken(opts.userId);
    fingerprint = token ? tokenFingerprint(token) : 'anon';
  } else {
    const { applyCrossInstanceCooldowns } = await import('./token-pool');
    await applyCrossInstanceCooldowns();
    const pooled = acquirePoolToken();
    token = pooled?.value;
    fingerprint = pooled?.fingerprint ?? 'anon';
  }

  const doFetch = (t: string | undefined) =>
    fetch(url, { ...init, headers: mergeHeaders(init, t) });

  const maxAttempts = method === 'GET' || method === 'HEAD' ? 3 : 1;
  const fetchWithRetry = async (t: string | undefined): Promise<Response> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await doFetch(t);
      } catch (err) {
        if (!isTransientNetworkError(err)) throw err;
        lastErr = err;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
    }
    throw new GithubNetworkError(maxAttempts, lastErr);
  };

  let res = await fetchWithRetry(token);
  const remainingHeader = res.headers.get('x-ratelimit-remaining');
  const remaining = remainingHeader === null ? Number.POSITIVE_INFINITY : Number(remainingHeader);
  const resetMs = parseReset(res.headers.get('x-ratelimit-reset'));

  void sampleQuota({ fingerprint, remaining, resetAt: resetMs ? new Date(resetMs) : null, endpointClass, status: res.status });

  const rateLimited = isRateLimited(res.status, remainingHeader, res, endpointClass);
  const cooldownUntil = Math.max(parseReset(res.headers.get('x-ratelimit-reset')) ?? 0, parseRetryAfter(res.headers.get('retry-after')) ?? 0);

  if (res.status === 401 && fingerprint !== 'anon') {
    markTokenQuarantined(fingerprint);
  } else if (rateLimited && fingerprint !== 'anon') {
    markTokenCooldown(fingerprint, cooldownUntil || undefined);
  }

  const canRotate = (rateLimited || res.status === 401) && !opts.explicitToken && (method === 'GET' || method === 'HEAD');

  if (canRotate) {
    const next = acquirePoolToken();
    if (next && next.value !== token) {
      console.warn(
        `[GithubClient] ${res.status} on ${endpointClass}, rotating token …${next.fingerprint} (pool=${JSON.stringify(poolStats())})`,
      );
      res = await fetchWithRetry(next.value);
      const retryRemainingHeader = res.headers.get('x-ratelimit-remaining');
      if (res.status === 401 && next.fingerprint !== 'anon') {
        markTokenQuarantined(next.fingerprint);
      } else if (isRateLimited(res.status, retryRemainingHeader, res, endpointClass)) {
        markTokenCooldown(next.fingerprint, Math.max(parseReset(res.headers.get('x-ratelimit-reset')) ?? 0, parseRetryAfter(res.headers.get('retry-after')) ?? 0) || undefined);
      }
      void sampleQuota({
        fingerprint: next.fingerprint,
        remaining: retryRemainingHeader === null ? Number.POSITIVE_INFINITY : Number(retryRemainingHeader),
        resetAt: parseReset(res.headers.get('x-ratelimit-reset')) ? new Date(parseReset(res.headers.get('x-ratelimit-reset'))!) : null,
        endpointClass,
        status: res.status,
      });
    }
  }

  return res;
}
