import { callSidecar } from '@/lib/sidecar-client';
import { publishPresence } from './presence-bus';

export interface TouchHeartbeatOptions {
  userId: string;
  clientName: string;
  clientVer?: string;
  ipAddress?: string;
}

/**
 * 客户端名归一化（UA/header → 展示名）。
 * McpActiveSession 与 McpCallLog 统计共用同一口径，防止面板两端数据无法关联。
 */
export function normalizeClientName(clientName: string): string {
  let normalizedName = clientName.trim();
  const lower = normalizedName.toLowerCase();
  if (lower.includes('cursor')) {
    normalizedName = 'Cursor IDE';
  } else if (lower.includes('claude')) {
    normalizedName = 'Claude Desktop';
  } else if (lower.includes('windsurf')) {
    normalizedName = 'Windsurf';
  } else if (lower.includes('cline')) {
    normalizedName = 'Cline';
  }
  return normalizedName;
}

/**
 * Persists or updates an active MCP client heartbeat session in DB via Go worker-sidecar.
 */
export async function touchMcpClientHeartbeat({
  userId,
  clientName,
  clientVer,
  ipAddress,
}: TouchHeartbeatOptions) {
  if (!userId || !clientName) return null;

  try {
    const normalizedName = normalizeClientName(clientName);

    await callSidecar<{ ok: boolean }>(
      '/v1/mcp/presence/touch',
      {
        userId,
        clientName: normalizedName,
        clientVer: clientVer || undefined,
        ipAddress: ipAddress || undefined,
      },
      { label: 'mcp-heartbeat' }
    );
    return {
      userId,
      clientName: normalizedName,
      clientVer: clientVer || null,
      ipAddress: ipAddress || null,
      status: 'ACTIVE',
      lastSeenAt: new Date(),
    };
  } catch (err) {
    console.error('[mcp-heartbeat] Failed to update heartbeat session via sidecar:', err);
    return null;
  }
}

/**
 * 路由层统一入口：落心跳（fire-and-forget）+ 即时发布 presence 事件（仪表盘实时推送）。
 * 返回归一化客户端名，供 runWithMcpClientContext 注入调用遥测上下文。
 */
// 心跳 30s 节流：在线判定窗口 90s（presenceStatus），30s 粒度保留 3 次余量，
// 同一用户×客户端的高频调用不再逐请求打 sidecar HTTP / presence 事件。
const touchThrottle = new Map<string, number>();
const TOUCH_INTERVAL_MS = 30 * 1000;
// 容量硬顶 + 陈旧清扫：超过 90s（3× 在线窗口）未活跃的键即淘汰——
// 离职/流失用户的条目不再随进程生命周期永久驻留
const TOUCH_THROTTLE_MAX_KEYS = 4096;
const TOUCH_STALE_MS = 3 * TOUCH_INTERVAL_MS;

export function recordMcpClientPresence(
  userId: string,
  clientHeader: string,
  ipAddress?: string,
): string {
  const clientName = normalizeClientName(clientHeader);
  const throttleKey = `${userId}|${clientName}`;
  const last = touchThrottle.get(throttleKey) ?? 0;
  if (Date.now() - last >= TOUCH_INTERVAL_MS) {
    const now = Date.now();
    touchThrottle.set(throttleKey, now);
    if (touchThrottle.size > TOUCH_THROTTLE_MAX_KEYS) {
      for (const [key, at] of touchThrottle) {
        if (now - at > TOUCH_STALE_MS) touchThrottle.delete(key);
      }
    }
    touchMcpClientHeartbeat({ userId, clientName, ipAddress }).catch((err) =>
      console.warn('[mcp-heartbeat] Presence touch warning:', err),
    );
  }
  publishPresence({ type: 'presence', userId, clientName, at: Date.now() });
  return clientName;
}
