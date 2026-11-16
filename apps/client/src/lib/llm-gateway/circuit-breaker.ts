/**
 * ─────────────────────────────────────────────────────────────
 * LLM 网关轻量级内存三态断路器 (Tri-State Circuit Breaker)
 *
 * 核心公理：第一性原理、失效封闭 (Fail-Closed)、零雪崩、自愈自适应
 *
 * 状态机跃迁拓扑：
 *   ┌─────────┐   failureCount >= threshold   ┌────────┐
 *   │         │ ─────────────────────────────> │        │
 *   │ CLOSED  │   failureRate >= rateThreshold │  OPEN  │
 *   │ (正常)  │ <───────────────────────────── │ (熔断) │
 *   └─────────┘     probeSuccess (探针成功)     └────────┘
 *        ^                                          │
 *        │                                          │ cooldownMs 超时
 *        │                                          v
 *        │         ┌───────────┐                    │
 *        └──────── │ HALF_OPEN │ <──────────────────┘
 *                  │ (探针恢复) │
 *                  └───────────┘
 *                        │ probeFailure (探针失败)
 *                        └─────────────────────> (切回 OPEN)
 * ─────────────────────────────────────────────────────────────
 */

type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface BreakerConfig {
  /** 触发熔断的连续失败次数阈值（默认 5 次） */
  failureThreshold: number;
  /** 滑动窗口失败率阈值（默认 0.5，即 50%） */
  failureRateThreshold: number;
  /** 滑动窗口请求容量（默认 10 次） */
  windowSize: number;
  /** 熔断后由 OPEN 转化为 HALF_OPEN 的冷却时间（默认 30,000ms） */
  cooldownMs: number;
  /** HALF_OPEN 放行的探针请求数（默认 1 个） */
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
  recentResults: boolean[]; // true = success, false = failure
  openedAt: number;
  probesInFlight: number;
  probeStartedAt: number;
}

/** 多语言与提供商速率限制判定（覆盖智谱/百炼/OpenAI/Claude 等中英文 429 特征） */
export function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { status?: number; statusCode?: number; message?: string };
  if (anyErr.status === 429 || anyErr.statusCode === 429) return true;
  const msg = String(anyErr.message || err).toLowerCase();
  return /rate limit|ratelimit|throttling|toomanyrequests|速率限制|请求频率|并发超限|429/i.test(msg);
}

/**
 * 判定错误是否属于触发熔断计数的基础设施/网络错误
 * 规则：
 * - 排除 401/403 (Key 无效/权限不足归属用户配置错误，不判定为服务商宕机)
 * - 排除 429 (限流属于瞬态退避，由重试消化，不计入服务商宕机熔断)
 * - 排除 400/404/422 (请求入参格式错误)
 * - 排除 BudgetExceededError 与 用户主动取消 (Abort)
 * - 计入 500/502/503/504 等 5xx 服务端异常与网络超时 (Timeout/ECONNREFUSED/FetchFailed)
 */
export function isTripEligibleError(err: unknown): boolean {
  if (!err) return false;

  const anyErr = err as {
    status?: number;
    statusCode?: number;
    message?: string;
    name?: string;
  };

  const status = anyErr.status ?? anyErr.statusCode;

  // 1. 认证/权限致命错误：Fail-closed，不污染断路器
  if (status === 401 || status === 403) return false;
  if (anyErr.name === 'MissingApiKeyError' || anyErr.name === 'BudgetExceededError') return false;

  // 2. 429 速率限制：走退避重试，不计入熔断
  if (isRateLimitError(err)) return false;

  // 3. 客户端主动中断
  if (anyErr.name === 'AbortError' && /aborted|cancelled/i.test(String(anyErr.message || ''))) {
    return false;
  }

  // 4. 业务/入参错误
  if (status === 400 || status === 404 || status === 422) return false;

  // 5. 明确的 5xx 服务端错误
  if (typeof status === 'number' && status >= 500 && status < 600) return true;

  // 6. 网络层连接失败与超时特征
  const msg = String(anyErr.message || err).toLowerCase();
  const isNetworkOrTimeout =
    /timeout|timed\s*out|econnrefused|econnreset|etimedout|enotfound|eai_again|epipe|und_err|socket\s*hang\s*up|socket\s*reset|reset\s*by\s*peer|connection\s*reset|fetch\s*failed|network\s*error|service\s*unavailable|bad\s*gateway|internal\s*server\s*error|gateway\s*timeout/i.test(
      msg
    );
  if (isNetworkOrTimeout) return true;

  // 兜底：若包含 500/502/503/504 关键字
  if (/500|502|503|504/.test(msg)) return true;

  return false;
}

/**
 * 构造断路器通道 Key（两级隔离机制）：
 * - 用户自备 Key：`user:${userId}:${provider}:${modelId}`
 * - 平台公共通道：`platform:${provider}:${modelId}`
 */
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

  /**
   * 检查指定通道当前是否允许放行调用
   * - CLOSED: 允许执行
   * - OPEN: 检查是否已过冷却时间；若已过则自动跃迁为 HALF_OPEN，否则短路返回 false (0 网络开销)
   * - HALF_OPEN: 仅放行 probeCount 个探针请求，超出探针配额的后续并发返回 false
   */
  canExecute(key: string): boolean {
    const channel = this.getOrInitChannel(key);
    const now = Date.now();

    if (channel.state === 'OPEN') {
      if (now - channel.openedAt >= this.config.cooldownMs) {
        // 冷却期结束，跃迁至半开探测态
        channel.state = 'HALF_OPEN';
        channel.probesInFlight = 0;
        channel.probeStartedAt = 0;
      } else {
        return false;
      }
    }

    if (channel.state === 'HALF_OPEN') {
      // 探针超时自愈防御：若在半开态有探针在途，但超过 cooldownMs 仍未汇报结果（请求挂死或泄漏），自动重置探针槽位
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

  /**
   * 释放探针配额（用于客户端主动中止、取消或无需计入熔断的外部退出）
   */
  releaseProbe(key: string): void {
    const channel = this.states.get(key);
    if (channel && channel.state === 'HALF_OPEN') {
      channel.probesInFlight = Math.max(0, channel.probesInFlight - 1);
    }
  }

  /**
   * 记录调用成功：
   * - HALF_OPEN 态：自愈恢复为 CLOSED 态，清空连续失败与探针计数
   * - CLOSED 态：连续失败重置为 0，滑动窗口写入成功 (true)
   */
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

  /**
   * 记录调用失败：
   * 1. HALF_OPEN 态：任何服务端/提供商失败（包括 429 限流）均表明探针未成功，立即打回 OPEN 态重置冷却；
   *    若为客户端主动中断 (AbortError)，则释放探针槽位供后续真实请求探测。
   * 2. CLOSED 态：必须经过 isTripEligibleError 智能过滤（排除 401 密钥错、429 瞬态限流、预算超限等）；
   *    对 5xx 与网络超时累加失败计数，达到连续阈值或滑动窗口阈值跃迁至 OPEN。
   */
  recordFailure(key: string, error: unknown): void {
    const channel = this.getOrInitChannel(key);

    if (channel.state === 'HALF_OPEN') {
      // 客户端主动取消或中止：不判定为服务商探针失败，释放探针槽位以供后续真实请求探测
      const anyErr = error as { name?: string; message?: string } | undefined;
      const isAbort =
        anyErr?.name === 'AbortError' ||
        /aborted|cancelled/i.test(String(anyErr?.message || ''));
      if (isAbort) {
        channel.probesInFlight = Math.max(0, channel.probesInFlight - 1);
        return;
      }

      // 探针失败（包括 5xx、超时、以及 429 限流等表明该模型当前无法正常出结果的故障）：
      // 探针失败必须立刻打回 OPEN 态，刷新 openedAt 开启新一轮冷却，绝不能死锁在 HALF_OPEN
      channel.state = 'OPEN';
      channel.openedAt = Date.now();
      channel.probesInFlight = 0;
      channel.probeStartedAt = 0;
      return;
    }

    // CLOSED 态熔断判定：必须通过 isTripEligibleError 智能过滤
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

  /**
   * 获取通道当前实时状态（若处于 OPEN 且冷却已过，实时投影为 HALF_OPEN）
   */
  getState(key: string): BreakerState {
    const channel = this.states.get(key);
    if (!channel) return 'CLOSED';
    if (channel.state === 'OPEN' && Date.now() - channel.openedAt >= this.config.cooldownMs) {
      return 'HALF_OPEN';
    }
    return channel.state;
  }

  /**
   * 获取通道观测指标
   */
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

  /**
   * 重置指定通道或全部通道状态（演练与单元测试用）
   */
  reset(key?: string): void {
    if (key) {
      this.states.delete(key);
    } else {
      this.states.clear();
    }
  }
}

/** 全局默认断路器单例 */
export const defaultCircuitBreaker = new CircuitBreaker();
