import { prisma } from '@/lib/db';

/**
 * MCP 活跃客户端读侧投影（零物化：全部由 McpActiveSession + McpCallLog 现算，无计数列）。
 * SSE 流与 HTTP 回落端点共用，保证两端口径一致。
 */

/** 90 秒内有心跳 = online（呼吸灯亮） */
export const MCP_PRESENCE_ONLINE_MS = 90 * 1000;
/** 5 分钟内有心跳 = recent（灰显）；超窗移除 */
export const MCP_PRESENCE_RECENT_MS = 5 * 60 * 1000;

/** sparkline 每客户端保留的最近调用格数 */
export const RECENT_TICKS_PER_CLIENT = 12;

export interface ProjectedClient {
  id: string;
  name: string;
  version: string | null;
  lastSeenAt: string;
  status: 'online' | 'recent';
  totalCalls: number;
  hitCalls: number;
  recentTicks: number[];
}

export function presenceStatus(lastSeenAtMs: number, now = Date.now()): 'online' | 'recent' | 'offline' {
  const age = now - lastSeenAtMs;
  if (age <= MCP_PRESENCE_ONLINE_MS) return 'online';
  if (age <= MCP_PRESENCE_RECENT_MS) return 'recent';
  return 'offline';
}

function startOfToday(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 全量快照投影：窗口内会话 + 每客户端当日调用统计。
 * 当日 totals 用两次 groupBy（精确命中口径：SUCCESS 且 resultCount>0），
 * ticks 用每客户端最近 12 条日志（客户端数有限，逐客户端小查询）。
 */
export async function projectActiveClients(userId: string, now = new Date()): Promise<ProjectedClient[]> {
  const sessions = await prisma.mcpActiveSession.findMany({
    where: {
      userId,
      lastSeenAt: { gte: new Date(now.getTime() - MCP_PRESENCE_RECENT_MS) },
    },
    orderBy: { lastSeenAt: 'desc' },
  });
  if (sessions.length === 0) return [];

  const dayStart = startOfToday(now);

  const [todayTotals, todayHits, tickLogs] = await Promise.all([
    prisma.mcpCallLog.groupBy({
      by: ['clientName'],
      where: { userId, createdAt: { gte: dayStart } },
      _count: { _all: true },
    }),
    prisma.mcpCallLog.groupBy({
      by: ['clientName'],
      where: { userId, createdAt: { gte: dayStart }, status: 'SUCCESS', resultCount: { gt: 0 } },
      _count: { _all: true },
    }),
    Promise.all(
      sessions.map((s) =>
        prisma.mcpCallLog
          .findMany({
            where: { userId, clientName: s.clientName },
            take: RECENT_TICKS_PER_CLIENT,
            orderBy: { createdAt: 'desc' },
            select: { status: true, resultCount: true },
          })
          .catch(() => []),
      ),
    ),
  ]);

  const totalsMap = new Map(todayTotals.map((r) => [r.clientName, r._count._all]));
  const hitsMap = new Map(todayHits.map((r) => [r.clientName, r._count._all]));

  return sessions.map((s, i) => {
    // 会话已按 5 分钟窗口过滤，offline 不可能出现；收窄类型防脏数据渗入投影
    const st = presenceStatus(s.lastSeenAt.getTime(), now.getTime());
    return {
      id: s.id,
      name: s.clientName,
      version: s.clientVer,
      lastSeenAt: s.lastSeenAt.toISOString(),
      status: st === 'offline' ? 'recent' : st,
      totalCalls: totalsMap.get(s.clientName) ?? 0,
      hitCalls: hitsMap.get(s.clientName) ?? 0,
      recentTicks: (tickLogs[i] ?? [])
        .map((log) => (log.status === 'SUCCESS' && log.resultCount > 0 ? 1 : 0))
        .reverse(),
    };
  });
}
