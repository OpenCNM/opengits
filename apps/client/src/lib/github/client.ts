import { tokenFingerprint, acquirePoolToken, markTokenCooldown, markTokenQuarantined, poolStats } from './token-pool';
import { resolveGithubToken } from '../github/token-resolver';

/**
 * ─────────────────────────────────────────────────────────────
 * GitHub 统一客户端咽喉（Phase 3 #1/#2）。
 *
 * 所有对 GitHub 的 fetch 经由本封装：
 * - 凭据：explicitToken 直用 → userId 走双轨（用户 OAuth）→ 平台池轮询；
 *   init.headers 里遗留的 Authorization 会被剥离重注，杜绝凭据混用
 * - 头感知：x-ratelimit-remaining=0 或 403/429 → 该 token 冷却至 resetAt，
 *   GET/HEAD 且无 body 时自动换 token 重试一次
 * - 瞬态网络重试：GET/HEAD 遇传输层中断（连接重置/拒绝/超时，undici 统一
 *   外壳 "fetch failed"）退避重试至 3 次尝试；耗尽抛 GithubNetworkError
 *   （准确文案），不再把裸 "fetch failed" 透传给界面
 * - 埋点：采样写 GithubQuotaLog（每 10 次 1 条 + remaining<200 必记），
 *   fire-and-forget 不影响主流程
 * - Response 原样透传（tarball 流式下载只读头不读体）
 * ─────────────────────────────────────────────────────────────
 */

export type GithubEndpointClass = 'api-core' | 'raw' | 'archive' | 'search';

export interface GithubFetchOptions {
  /** 用户 OAuth 双轨（导入/更新等有操作者身份的链路）；缺省走平台池 */
  userId?: string | null;
  /** 显式 token（调用方已持有，如调度器探测传入）；优先级最高，不参与池化 */
  explicitToken?: string;
  endpointClass?: GithubEndpointClass;
}

let callCounter = 0;

/** 传输层瞬态失败特征：undici 把连接重置/拒绝/超时/TLS 中断统一包装成
 *  TypeError("fetch failed")，真实原因在 cause 链上（ECONNRESET 等）。
 *  仅匹配传输层词汇——HTTP 语义错误（401/404/403…）走状态机，不进重试。 */
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
  // AbortError（调用方主动取消）绝不能重试：消息不含传输层词汇，天然不命中
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
    headers.delete('Authorization'); // 池未选中/匿名：剥离调用方遗留凭据
  }
  return headers;
}

function parseReset(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const sec = Number(headerValue);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : undefined;
}

/** retry-after 是相对秒数（非 epoch）——折算为绝对时刻 */
function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const sec = Number(headerValue);
  return Number.isFinite(sec) && sec > 0 ? (sec + Math.floor(Date.now() / 1000)) * 1000 : undefined;
}

/**
 * 403 消歧（T6.3）：GitHub 的 403 既可能是限流也可能是"无权限/私仓不可见"。
 * 仅 remaining=0、带 retry-after、或状态 429 才按限流处理（冷却+轮换）；
 * 其余 403 透传——否则无权限仓库会把健康 token 反复误冷却 60s。
 */
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
  // 无配额头（raw/archive 类端点不回 x-ratelimit-remaining）没有可记信号：
  // Infinity 落库必炸 Prisma Int 序列化（被吞后这两类端点采样恒失败）
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
      res.catch(() => undefined);
    }
  } catch {
    // 埋点失败零影响
  }
}

export async function githubFetch(
  url: string,
  init: RequestInit = {},
  opts: GithubFetchOptions = {}
): Promise<Response> {
  const endpointClass = opts.endpointClass ?? 'api-core';
  const method = (init.method || 'GET').toUpperCase();

  // ── 凭据解析 ──
  let token: string | undefined;
  let fingerprint: string;
  if (opts.explicitToken) {
    token = opts.explicitToken;
    fingerprint = tokenFingerprint(token);
  } else if (opts.userId) {
    token = await resolveGithubToken(opts.userId);
    fingerprint = token ? tokenFingerprint(token) : 'anon';
    // 用户 OAuth 无池语义；resolver 内部回退到完整平台池（token-resolver）
  } else {
    // 池化路径：先吸收跨实例冷却（其他 web/worker 已打爆的 token 不重复撞墙）
    const { applyCrossInstanceCooldowns } = await import('./token-pool');
    await applyCrossInstanceCooldowns();
    const pooled = acquirePoolToken();
    token = pooled?.value;
    fingerprint = pooled?.fingerprint ?? 'anon';
  }

  const doFetch = (t: string | undefined) =>
    fetch(url, { ...init, headers: mergeHeaders(init, t) });

  // 瞬态网络重试（对齐 Go 侧 GithubGetJSON 语义）：幂等方法传输层中断
  // 退避重试；非幂等方法（POST 等）与调用方 abort 不重试
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

  // ── 头感知冷却 / 401 隔离 + 单次换 token 重试（幂等方法且非显式 token 场景）──
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
