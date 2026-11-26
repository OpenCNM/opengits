import { callSidecar } from '@/lib/sidecar-client';
import { publishPresence } from './presence-bus';

export interface TouchHeartbeatOptions {
  userId: string;
  clientName: string;
  clientVer?: string;
  ipAddress?: string;
}

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

// 30s throttle gives 3x margin inside the 90s online window while bounding stale entries at 4096 keys.
const touchThrottle = new Map<string, number>();
const TOUCH_INTERVAL_MS = 30 * 1000;
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
