import { prisma } from '@/lib/db';
import { callSidecar } from '@/lib/sidecar-client';

export interface RateLimitCheckResult {
  allowed: boolean;
  reason?: 'BANNED' | 'RPM_EXCEEDED' | 'DAILY_QUOTA_EXCEEDED';
  status: number;
  rpmLimit: number;
  rpmRemaining: number;
  dailyLimit: number;
  dailyRemaining: number;
  tokenCap: number;
  headers: Record<string, string>;
  errorJson?: unknown;
}

interface UserMemoryStats {
  timestamps: number[];
}

const memoryStore = new Map<string, UserMemoryStats>();

function utcDayKey(): string {
  return new Date().toISOString().split('T')[0];
}

async function recordLedgerCall(userId: string, day: string): Promise<void> {
  try {
    await callSidecar<{ ok: boolean }>(
      '/v1/mcp/usage/increment',
      { userId, day },
      { label: 'mcp-rate-limiter' }
    );
  } catch (err) {
    console.warn('[McpRateLimiter] ledger increment failed:', err);
  }
}

export class McpRateLimiter {
  static async checkLimit(
    identifier: string,
    userRole: string = 'USER'
  ): Promise<RateLimitCheckResult> {
    const now = Date.now();
    const day = utcDayKey();

    let isBanned = false;
    let rpmLimit = 30;
    let dailyLimit = 100;
    let tokenCap = 4000;

    if (identifier && identifier !== 'anonymous') {
      const isEmail = identifier.includes('@');
      const user = isEmail
        ? await prisma.user.findUnique({
            where: { email: identifier },
            select: {
              isBanned: true,
              mcpRpmLimit: true,
              dailyMcpQuota: true,
              singleCallTokenCap: true,
            },
          }).catch(() => null)
        : await prisma.user.findUnique({
            where: { id: identifier },
            select: {
              isBanned: true,
              mcpRpmLimit: true,
              dailyMcpQuota: true,
              singleCallTokenCap: true,
            },
          }).catch(() => null);

      if (user) {
        isBanned = user.isBanned;
        rpmLimit = user.mcpRpmLimit ?? 30;
        dailyLimit = user.dailyMcpQuota ?? 100;
        tokenCap = user.singleCallTokenCap ?? 4000;
      }
    }

    if (userRole === 'ADMIN' || userRole === 'SUPER_ADMIN') {
      dailyLimit = 0;
      rpmLimit = 600;
      tokenCap = 32000;
    }

    if (isBanned) {
      return {
        allowed: false,
        reason: 'BANNED',
        status: 403,
        rpmLimit,
        rpmRemaining: 0,
        dailyLimit,
        dailyRemaining: 0,
        tokenCap,
        headers: {
          'x-ratelimit-banned': 'true',
        },
        errorJson: {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Access Denied: Account is currently suspended by system administrator.',
          },
          id: null,
        },
      };
    }

    // Daily quota comes from the durable DB ledger; RPM uses a bounded in-memory sliding window (>512 keys prunes expired entries).
    const canUseLedger = identifier !== 'anonymous';
    let dailyCount = 0;
    if (canUseLedger && dailyLimit > 0) {
      const ledger = await prisma.mcpUsageLedger
        .findUnique({ where: { userId_day: { userId: identifier, day } } })
        .catch(() => null);
      dailyCount = ledger?.mcpCalls ?? 0;
    }

    let userStats = memoryStore.get(identifier);
    if (!userStats) {
      userStats = { timestamps: [] };
      memoryStore.set(identifier, userStats);
    }

    const windowStart = now - 60 * 1000;
    userStats.timestamps = userStats.timestamps.filter((ts) => ts > windowStart);

    if (userStats.timestamps.length === 0 && memoryStore.size > 512) {
      for (const [key, stats] of memoryStore) {
        if (stats.timestamps.length === 0 || stats.timestamps.every((ts) => ts <= windowStart)) {
          memoryStore.delete(key);
        }
      }
      userStats = memoryStore.get(identifier) ?? userStats;
      if (!memoryStore.has(identifier)) memoryStore.set(identifier, userStats);
    }

    const currentRpm = userStats.timestamps.length;
    const rpmRemaining = Math.max(0, rpmLimit - currentRpm);

    const dailyRemaining = dailyLimit === 0 ? 999999 : Math.max(0, dailyLimit - dailyCount);

    const headers: Record<string, string> = {
      'x-ratelimit-limit-rpm': String(rpmLimit),
      'x-ratelimit-remaining-rpm': String(rpmRemaining),
      'x-ratelimit-limit-daily': String(dailyLimit),
      'x-ratelimit-remaining-daily': String(dailyRemaining),
      'x-ratelimit-tokencap': String(tokenCap),
    };

    if (rpmLimit > 0 && currentRpm >= rpmLimit) {
      return {
        allowed: false,
        reason: 'RPM_EXCEEDED',
        status: 429,
        rpmLimit,
        rpmRemaining: 0,
        dailyLimit,
        dailyRemaining,
        tokenCap,
        headers: {
          ...headers,
          'Retry-After': '60',
        },
        errorJson: {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: `Rate limit exceeded: Requests Per Minute (RPM) limit reached (${currentRpm}/${rpmLimit} RPM). Please slow down.`,
            data: { retryAfterSeconds: 60, limitType: 'RPM' },
          },
          id: null,
        },
      };
    }

    if (dailyLimit > 0 && dailyCount >= dailyLimit) {
      return {
        allowed: false,
        reason: 'DAILY_QUOTA_EXCEEDED',
        status: 429,
        rpmLimit,
        rpmRemaining,
        dailyLimit,
        dailyRemaining: 0,
        tokenCap,
        headers,
        errorJson: {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: `Rate limit exceeded: Daily MCP tool quota reached (${dailyCount}/${dailyLimit} requests/day). Please try again tomorrow.`,
            data: { limitType: 'DAILY_QUOTA' },
          },
          id: null,
        },
      };
    }

    userStats.timestamps.push(now);
    if (canUseLedger) {
      await recordLedgerCall(identifier, day);
    }

    const postRpmRemaining = Math.max(0, rpmLimit - userStats.timestamps.length);
    const postDailyRemaining = dailyLimit === 0 ? 999999 : Math.max(0, dailyLimit - dailyCount - 1);

    const updatedHeaders: Record<string, string> = {
      'x-ratelimit-limit-rpm': String(rpmLimit),
      'x-ratelimit-remaining-rpm': String(postRpmRemaining),
      'x-ratelimit-limit-daily': String(dailyLimit),
      'x-ratelimit-remaining-daily': String(postDailyRemaining),
      'x-ratelimit-tokencap': String(tokenCap),
    };

    return {
      allowed: true,
      status: 200,
      rpmLimit,
      rpmRemaining: postRpmRemaining,
      dailyLimit,
      dailyRemaining: postDailyRemaining,
      tokenCap,
      headers: updatedHeaders,
    };
  }
}
