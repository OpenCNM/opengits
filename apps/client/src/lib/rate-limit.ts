import type Redis from 'ioredis';
import { ignoreBestEffort } from '@/lib/best-effort';

const REDIS_URL = process.env.REDIS_URL || '';
const KEY_PREFIX = 'opengits:rl:';

interface RateLimitDriver {
  hit(key: string, limit: number, windowMs: number): Promise<boolean>;
  name: string;
}

const memoryMap = new Map<string, { count: number; lastReset: number }>();

const memoryDriver: RateLimitDriver = {
  name: 'memory',
  async hit(key, limit, windowMs) {
    const now = Date.now();
    if (memoryMap.size > 5000) {
      const oldestKey = memoryMap.keys().next().value;
      if (oldestKey !== undefined) memoryMap.delete(oldestKey);
    }
    const record = memoryMap.get(key);
    if (!record) {
      memoryMap.set(key, { count: 1, lastReset: now });
      return true;
    }
    // Re-insert to refresh insertion order for O(1) LRU eviction above.
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

let redisClient: Redis | null = null;
let redisBrokenUntil = 0;

async function getRedis(): Promise<Redis | null> {
  if (!REDIS_URL) return null;
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
    });
    return redisClient;
  } catch {
    ignoreBestEffort();
    // Open a 60s circuit breaker on Redis setup failure so requests fail open instead of piling up.
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
      return true;
    }
    try {
      if (redis.status !== 'ready' && redis.status !== 'connecting') {
        await redis.connect().catch(ignoreBestEffort);
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
      redisBrokenUntil = Date.now() + 60_000;
      logThrottled(`redis hit failed (${err instanceof Error ? err.message : err}), fail-open`);
      return true;
    }
  },
};

let activeDriver: RateLimitDriver = REDIS_URL ? redisDriver : memoryDriver;

export function rateLimitDriverName(): string {
  return activeDriver.name;
}

export function __setRateLimitDriverForTests(driver: RateLimitDriver | null): void {
  activeDriver = driver ?? (REDIS_URL ? redisDriver : memoryDriver);
}

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

// Assumes a trusted reverse proxy supplies the leftmost client hop in X-Forwarded-For.
export function clientIpFromRequest(headers: Headers): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}
