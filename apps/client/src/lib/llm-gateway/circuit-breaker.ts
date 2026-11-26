type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface BreakerConfig {
  failureThreshold: number;
  failureRateThreshold: number;
  windowSize: number;
  cooldownMs: number;
  probeCount: number;
}

interface BreakerChannelStats {
  state: BreakerState;
  consecutiveFailures: number;
  windowSize: number;
  failureRate: number;
  openedAt: number;
  probesInFlight: number;
}

interface InternalChannelState {
  state: BreakerState;
  consecutiveFailures: number;
  recentResults: boolean[];
  openedAt: number;
  probesInFlight: number;
  probeStartedAt: number;
}

import { extractUpstreamError } from './upstream-error';

export function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const info = extractUpstreamError(err);
  if (info.code === 'RATE_LIMITED' || info.upstreamStatus === 429) return true;
  const anyErr = err as { status?: number; statusCode?: number; message?: string };
  if (anyErr.status === 429 || anyErr.statusCode === 429) return true;
  const msg = String(anyErr.message || err).toLowerCase();
  return /rate limit|ratelimit|throttling|toomanyrequests|速率限制|请求频率|并发超限|429/i.test(msg);
}

// Exclude 4xx client/auth/quota/429/Abort errors so account or transient-backoff issues never trip provider outage state.
export function isTripEligibleError(err: unknown): boolean {
  if (!err) return false;

  const anyErr = err as {
    status?: number;
    statusCode?: number;
    message?: string;
    name?: string;
  };

  if (anyErr.name === 'AbortError' && /aborted|cancelled/i.test(String(anyErr.message || ''))) {
    return false;
  }

  const info = extractUpstreamError(err);

  if (
    info.code === 'MISSING_API_KEY' ||
    info.code === 'KEY_DECRYPT_FAILED' ||
    info.code === 'BUDGET_EXCEEDED' ||
    info.code === 'UPSTREAM_AUTH_ERROR' ||
    info.code === 'UPSTREAM_QUOTA_EXCEEDED' ||
    info.code === 'UPSTREAM_MODEL_NOT_FOUND' ||
    info.code === 'UPSTREAM_BAD_REQUEST' ||
    info.code === 'RATE_LIMITED'
  ) {
    return false;
  }

  if (info.code === 'UPSTREAM_SERVER_ERROR' || info.code === 'UPSTREAM_NETWORK_ERROR') {
    return true;
  }

  const status = info.upstreamStatus ?? anyErr.status ?? anyErr.statusCode;
  if (status === 401 || status === 402 || status === 403 || status === 400 || status === 404 || status === 422 || status === 429) {
    return false;
  }
  if (typeof status === 'number' && status >= 500 && status < 600) return true;

  const msg = String(anyErr.message || err).toLowerCase();
  if (/500|502|503|504/.test(msg)) return true;

  return false;
}

export function buildBreakerKey(provider: string, modelId?: string, userId?: string | null): string {
  const cleanProvider = (provider || 'default').trim().toLowerCase();
  const cleanModel = (modelId || 'default').trim().toLowerCase();
  if (userId && userId.trim()) {
    return `user:${userId.trim()}:${cleanProvider}:${cleanModel}`;
  }
  return `platform:${cleanProvider}:${cleanModel}`;
}

export class CircuitBreaker {
  private readonly config: BreakerConfig;
  private readonly states = new Map<string, InternalChannelState>();

  constructor(config?: Partial<BreakerConfig>) {
    this.config = {
      failureThreshold: config?.failureThreshold ?? 5,
      failureRateThreshold: config?.failureRateThreshold ?? 0.5,
      windowSize: config?.windowSize ?? 10,
      cooldownMs: config?.cooldownMs ?? 30_000,
      probeCount: config?.probeCount ?? 1,
    };
  }

  private getOrInitChannel(key: string): InternalChannelState {
    let channel = this.states.get(key);
    if (!channel) {
      channel = {
        state: 'CLOSED',
        consecutiveFailures: 0,
        recentResults: [],
        openedAt: 0,
        probesInFlight: 0,
        probeStartedAt: 0,
      };
      this.states.set(key, channel);
    }
    return channel;
  }

  canExecute(key: string): boolean {
    const channel = this.getOrInitChannel(key);
    const now = Date.now();

    if (channel.state === 'OPEN') {
      if (now - channel.openedAt >= this.config.cooldownMs) {
        channel.state = 'HALF_OPEN';
        channel.probesInFlight = 0;
        channel.probeStartedAt = 0;
      } else {
        return false;
      }
    }

    if (channel.state === 'HALF_OPEN') {
      // Auto-recover leaked probe slots if an in-flight HALF_OPEN probe hangs past cooldownMs.
      if (
        channel.probesInFlight > 0 &&
        channel.probeStartedAt > 0 &&
        now - channel.probeStartedAt >= this.config.cooldownMs
      ) {
        channel.probesInFlight = 0;
      }

      if (channel.probesInFlight < this.config.probeCount) {
        channel.probesInFlight++;
        channel.probeStartedAt = now;
        return true;
      }
      return false;
    }

    return true;
  }

  releaseProbe(key: string): void {
    const channel = this.states.get(key);
    if (channel && channel.state === 'HALF_OPEN') {
      channel.probesInFlight = Math.max(0, channel.probesInFlight - 1);
    }
  }

  recordSuccess(key: string): void {
    const channel = this.getOrInitChannel(key);

    if (channel.state === 'HALF_OPEN') {
      channel.state = 'CLOSED';
      channel.consecutiveFailures = 0;
      channel.recentResults = [true];
      channel.openedAt = 0;
      channel.probesInFlight = 0;
      channel.probeStartedAt = 0;
      return;
    }

    if (channel.state === 'CLOSED') {
      channel.consecutiveFailures = 0;
      channel.recentResults.push(true);
      if (channel.recentResults.length > this.config.windowSize) {
        channel.recentResults.shift();
      }
    }
  }

  recordFailure(key: string, error: unknown): void {
    const channel = this.getOrInitChannel(key);

    if (channel.state === 'HALF_OPEN') {
      // Client aborts release the HALF_OPEN probe slot without tripping; any upstream failure (including 429) immediately re-opens.
      const anyErr = error as { name?: string; message?: string } | undefined;
      const isAbort =
        anyErr?.name === 'AbortError' ||
        /aborted|cancelled/i.test(String(anyErr?.message || ''));
      if (isAbort) {
        channel.probesInFlight = Math.max(0, channel.probesInFlight - 1);
        return;
      }

      channel.state = 'OPEN';
      channel.openedAt = Date.now();
      channel.probesInFlight = 0;
      channel.probeStartedAt = 0;
      return;
    }

    if (!isTripEligibleError(error)) {
      return;
    }

    if (channel.state === 'CLOSED') {
      channel.consecutiveFailures++;
      channel.recentResults.push(false);
      if (channel.recentResults.length > this.config.windowSize) {
        channel.recentResults.shift();
      }

      const failuresInWindow = channel.recentResults.filter((res) => !res).length;
      const failureRate =
        channel.recentResults.length > 0 ? failuresInWindow / channel.recentResults.length : 0;

      const trippedByConsecutive = channel.consecutiveFailures >= this.config.failureThreshold;
      const trippedByRate =
        channel.recentResults.length >= this.config.windowSize &&
        failureRate >= this.config.failureRateThreshold;

      if (trippedByConsecutive || trippedByRate) {
        channel.state = 'OPEN';
        channel.openedAt = Date.now();
        channel.probesInFlight = 0;
        channel.probeStartedAt = 0;
      }
    }
  }

  getState(key: string): BreakerState {
    const channel = this.states.get(key);
    if (!channel) return 'CLOSED';
    if (channel.state === 'OPEN' && Date.now() - channel.openedAt >= this.config.cooldownMs) {
      return 'HALF_OPEN';
    }
    return channel.state;
  }

  getStats(key: string): BreakerChannelStats {
    const channel = this.getOrInitChannel(key);
    const failuresInWindow = channel.recentResults.filter((res) => !res).length;
    const failureRate =
      channel.recentResults.length > 0 ? failuresInWindow / channel.recentResults.length : 0;

    return {
      state: this.getState(key),
      consecutiveFailures: channel.consecutiveFailures,
      windowSize: channel.recentResults.length,
      failureRate,
      openedAt: channel.openedAt,
      probesInFlight: channel.probesInFlight,
    };
  }

  reset(key?: string): void {
    if (key) {
      this.states.delete(key);
    } else {
      this.states.clear();
    }
  }
}

export const defaultCircuitBreaker = new CircuitBreaker();
