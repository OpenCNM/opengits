import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const callSidecarMock = vi.fn();
const getSessionMock = vi.fn();

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: () => getSessionMock(),
}));

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
}));

/**
 * 守护两侧事件注册表同步（TS ↔ Go 白名单是手工镜像，漂移即静默丢数据）：
 * Go allowedMonitorEventKinds（store_monitor.go）必须与 TS MONITOR_EVENT_KINDS
 * 逐值一致——任何一侧增删 kind，此测试立即变红。
 */
describe('Monitor Event Kinds 两侧同步守护', () => {
  it('TS MONITOR_EVENT_KINDS 与 Go allowedMonitorEventKinds 完全一致', async () => {
    const { MONITOR_EVENT_KINDS } = await import('@/lib/monitor/events');
    const tsKinds = new Set(Object.values(MONITOR_EVENT_KINDS));

    const goSource = readFileSync(
      resolve(__dirname, '../../services/worker-sidecar/internal/userinteraction/store_monitor.go'),
      'utf-8',
    );
    const mapStart = goSource.indexOf('var allowedMonitorEventKinds');
    // 闭合括号取行首 `\n}`（内层空 struct `{}` 不在行首，不会被误命中）
    const mapEnd = goSource.indexOf('\n}', mapStart);
    expect(mapStart).toBeGreaterThanOrEqual(0);
    const mapBody = goSource.slice(mapStart, mapEnd);
    const goKinds = new Set(
      Array.from(mapBody.matchAll(/"([A-Z_]+)":\s*\{\}/g)).map((m) => m[1]),
    );

    expect(goKinds.size).toBeGreaterThan(0);
    const onlyInTs = [...tsKinds].filter((k) => !goKinds.has(k));
    const onlyInGo = [...goKinds].filter((k) => !tsKinds.has(k));
    expect(onlyInTs, `仅 TS 侧存在（Go 白名单未同步）: ${onlyInTs.join(', ')}`).toEqual([]);
    expect(onlyInGo, `仅 Go 侧存在（TS 注册表未同步）: ${onlyInGo.join(', ')}`).toEqual([]);
  });
});

describe('Monitor API 网关行为（Item：未知 kind 丢弃 / 合法事件转发）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({ user: { id: 'user-1' } });
    callSidecarMock.mockResolvedValue({ ok: true, count: 1 });
  });

  it('drops unwhitelisted kinds and malformed payloads, forwards valid ones', async () => {
    const { POST } = await import('@/app/api/monitor/route');

    const req = new NextRequest('http://localhost/api/monitor', {
      method: 'POST',
      body: JSON.stringify({
        events: [
          {
            kind: 'JS_ERROR',
            pageUrl: '/docs/owner/repo',
            sessionId: 'sess-1',
            payload: { message: 'boom', stack: '    at fn (chunk.js:1:2)' },
          },
          { kind: 'INJECTED_MALICIOUS_KIND', pageUrl: '/x', sessionId: 'sess-1' },
          // 合法 kind 但 payload 形状漂移（缺 message）→ Frame-1 丢弃
          { kind: 'JS_ERROR', pageUrl: '/y', sessionId: 'sess-1', payload: { wrong: true } },
          {
            kind: 'WEB_VITALS',
            pageUrl: '/docs/owner/repo',
            sessionId: 'sess-1',
            payload: { lcpMs: 1200, inpMs: 210, cls: 0.05 },
          },
        ],
      }),
    });

    // 两条合法事件转发，sidecar 回执 count=2（beforeEach 默认回执为 1，此处覆写）
    callSidecarMock.mockResolvedValueOnce({ ok: true, count: 2 });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.count).toBe(2);

    expect(callSidecarMock).toHaveBeenCalledTimes(1);
    const [endpoint, body] = callSidecarMock.mock.calls[0];
    expect(endpoint).toBe('/v1/monitor/events');
    expect((body as { userId: string }).userId).toBe('user-1');
    const forwarded = (body as { events: Array<{ kind: string }> }).events;
    expect(forwarded.map((e) => e.kind)).toEqual(['JS_ERROR', 'WEB_VITALS']);
  });

  it('returns count 0 without sidecar call when all events invalid', async () => {
    const { POST } = await import('@/app/api/monitor/route');

    const req = new NextRequest('http://localhost/api/monitor', {
      method: 'POST',
      body: JSON.stringify({
        events: [{ kind: 'UNKNOWN_1', pageUrl: '/x', sessionId: 's' }],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.count).toBe(0);
    expect(callSidecarMock).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests with 401', async () => {
    getSessionMock.mockResolvedValue(null);
    const { POST } = await import('@/app/api/monitor/route');

    const req = new NextRequest('http://localhost/api/monitor', {
      method: 'POST',
      body: JSON.stringify({ events: [] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(callSidecarMock).not.toHaveBeenCalled();
  });
});
