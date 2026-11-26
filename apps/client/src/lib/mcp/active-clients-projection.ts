import { prisma } from '@/lib/db';

export const MCP_PRESENCE_ONLINE_MS = 90 * 1000;
export const MCP_PRESENCE_RECENT_MS = 5 * 60 * 1000;

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
