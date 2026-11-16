import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

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

describe('Telemetry Event Whitelist (Item 7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({ user: { id: 'user-1' } });
    callSidecarMock.mockResolvedValue({ ok: true, count: 2 });
  });

  it('drops unwhitelisted event types and saves only valid ones', async () => {
    const { POST } = await import('@/app/api/telemetry/route');

    const req = new NextRequest('http://localhost/api/telemetry', {
      method: 'POST',
      body: JSON.stringify({
        events: [
          { eventType: 'PAGE_VIEW', pageUrl: '/test' },
          { eventType: 'INJECTED_MALICIOUS_EVENT', pageUrl: '/hacked' },
          { eventType: 'CODE_COPY', pageUrl: '/test2' },
        ],
      }),
    });

    callSidecarMock.mockResolvedValueOnce({ ok: true, count: 2 });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.count).toBe(2);

    expect(callSidecarMock).toHaveBeenCalledTimes(1);
    const calledArgs = callSidecarMock.mock.calls[0];
    expect(calledArgs[0]).toBe('/v1/telemetry/events');
    const forwardedEvents = (calledArgs[1] as any).events;
    expect(forwardedEvents.length).toBe(2);
    expect(forwardedEvents.map((e: any) => e.eventType)).toEqual(['PAGE_VIEW', 'CODE_COPY']);
  });

  it('returns count 0 when all events are unwhitelisted', async () => {
    const { POST } = await import('@/app/api/telemetry/route');

    const req = new NextRequest('http://localhost/api/telemetry', {
      method: 'POST',
      body: JSON.stringify({
        events: [
          { eventType: 'UNKNOWN_1' },
          { eventType: 'UNKNOWN_2' },
        ],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.count).toBe(0);
    expect(callSidecarMock).not.toHaveBeenCalled();
  });
});

