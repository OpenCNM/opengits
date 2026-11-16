import type Redis from 'ioredis';

/**
 * ─────────────────────────────────────────────────────────────
 * 可插拔限流器（Phase 1 T5：多实例共享窗口）。
 *
 * 驱动选择：配置 REDIS_URL → Redis 滑动窗口（精确 ZSET 计数，跨实例一致）；
 * 未配置 → 进程内固定窗口（单机语义，与历史行为逐字兼容）。
 *
 * fail-open 契约：Redis 连接失败/命令异常时视为放行（核心功能零中断），
 * 告警日志按 30s 节流防风暴。接口为 async——调用方 `if (!(await checkRateLimit(...)))`。
 * ─────────────────────────────────────────────────────────────
 */

const REDIS_URL = process.env.REDIS_URL || '';
const KEY_PREFIX = 'opengits:rl:';

interface RateLimitDriver {
  /** 记一次并返回是否放行 */
  hit(key: string, limit: number, windowMs: number): Promise<boolean>;
  name: string;
}

/* ── 内存固定窗口驱动（默认；单机语义） ── */

const memoryMap = new Map<string, { count: number; lastReset: number }>();

const memoryDriver: RateLimitDriver = {
  name: 'memory',
  async hit(key, limit, windowMs) {
    const now = Date.now();
    // Map 按插入序淘汰，防内存泄漏
    if (memoryMap.size > 5000) {
      const oldestKey = memoryMap.keys().next().value;
      if (oldestKey !== undefined) memoryMap.delete(oldestKey);
    }
    const record = memoryMap.get(key);
    if (!record) {
      memoryMap.set(key, { count: 1, lastReset: now });
      return true;
    }
    // 命中刷新插入序（delete+set）：否则淘汰按插入序会误逐早期插入的热键
    memoryMap.delete(key);
    memoryMap.set(key, record);
    if (now - record.lastReset > windowMs) {
      record.count = 1;
      record.lastReset = now;
      return true;
    }
    if (record.count >= limit) return false;
    record.count += 1;
    return true;
  },
};

/* ── Redis 滑动窗口驱动（REDIS_URL 配置时启用） ── */

let redisClient: Redis | null = null;
let redisBrokenUntil = 0;

async function getRedis(): Promise<Redis | null> {
  if (!REDIS_URL) return null;
  // 熔断冷却期内不再尝试建连（fail-open 已在兜底）
  if (Date.now() < redisBrokenUntil) return null;
  if (redisClient) return redisClient;
  try {
    const Ctor = (await import('ioredis')).default;
    redisClient = new Ctor(REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
    });
    redisClient.on('error', () => {
      // 连接级错误由 hit() 的 try/catch 统一熔断；此处仅防 unhandled
    });
    return redisClient;
  } catch {
    redisBrokenUntil = Date.now() + 60_000;
    return null;
  }
}

let lastFailLogAt = 0;

function logThrottled(message: string): void {
  const now = Date.now();
  if (now - lastFailLogAt < 30_000) return;
  lastFailLogAt = now;
  console.warn(`[rate-limit] ${message}`);
  // redis 故障导致限流 fail-open 是安全事件（全站写接口裸奔窗口）——上报告警
  void import('@/lib/observability/errors').then((m) =>
    m.captureWarn(`限流降级：${message}`, { scope: 'rate-limit/fail-open' })
  );
}

const redisDriver: RateLimitDriver = {
  name: 'redis',
  async hit(key, limit, windowMs) {
    const redis = await getRedis();
    if (!redis) {
      logThrottled('redis unavailable, fail-open');
      return true; // fail-open
    }
    try {
      if (redis.status !== 'ready' && redis.status !== 'connecting') {
        await redis.connect().catch(() => undefined);
      }
      const k = `${KEY_PREFIX}${key}`;
      const now = Date.now();
      const member = `${now}-${Math.random().toString(36).slice(2, 8)}`;
      const results = await redis
        .multi()
        .zremrangebyscore(k, 0, now - windowMs)
        .zadd(k, now, member)
        .zcard(k)
        .pexpire(k, windowMs)
        .exec();
      if (!results) throw new Error('empty pipeline result');
      const count = Number(results[2]?.[1] ?? 0);
      return count <= limit;
    } catch (err) {
      redisBrokenUntil = Date.now() + 60_000; // 熔断 60s 后重试建连
      logThrottled(`redis hit failed (${err instanceof Error ? err.message : err}), fail-open`);
      return true; // fail-open
    }
  },
};

let activeDriver: RateLimitDriver = REDIS_URL ? redisDriver : memoryDriver;

/** 当前驱动名（观测/测试用） */
export function rateLimitDriverName(): string {
  return activeDriver.name;
}

/** 测试注入点（切换驱动 / 注入故障驱动） */
export function __setRateLimitDriverForTests(driver: RateLimitDriver | null): void {
  activeDriver = driver ?? (REDIS_URL ? redisDriver : memoryDriver);
}

/**
 * 检查并记录一次访问。超过窗口配额返回 false。
 * @param identifier 维度键（userId/IP/动作前缀）
 */
export async function checkRateLimit(
  identifier: string,
  limit: number = 5,
  windowMs: number = 60000
): Promise<boolean> {
  try {
    return await activeDriver.hit(identifier, limit, windowMs);
  } catch (err) {
    logThrottled(`driver threw (${err instanceof Error ? err.message : err}), fail-open`);
    return true;
  }
}

/** 从代理链头提取客户端 IP（caddy reverse_proxy 已注入 x-forwarded-for，取第一跳） */
export function clientIpFromRequest(headers: Headers): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}
