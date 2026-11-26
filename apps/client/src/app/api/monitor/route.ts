import { NextRequest, NextResponse } from 'next/server';
import { getSessionHelper } from '@/lib/auth-helper';
import { checkRateLimit } from '@/lib/rate-limit';
import { callSidecar } from '@/lib/sidecar-client';
import { monitorEventSchema } from '@/lib/monitor/schemas';

const MAX_EVENTS_PER_BATCH = 50;
const MONITOR_RATE_LIMIT = 30;

interface MonitorSidecarResponse {
  ok: boolean;
  count?: number;
  error?: string;
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSessionHelper();
    if (!session || !session.user || !session.user.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const userId = session.user.id;

    if (!(await checkRateLimit(`monitor:${userId}`, MONITOR_RATE_LIMIT, 60000))) {
      return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
    }

    const body = await req.json();
    const { events } = body ?? {};

    if (!Array.isArray(events) || events.length === 0) {
      return NextResponse.json({ success: true, count: 0 });
    }

    const rawEvents = events.slice(0, MAX_EVENTS_PER_BATCH);
    const validEvents: unknown[] = [];
    for (const ev of rawEvents) {
      const parsed = monitorEventSchema.safeParse(ev);
      if (parsed.success) {
        validEvents.push(parsed.data);
        continue;
      }
      console.warn('[Monitor API] dropped malformed event', {
        kind: typeof ev?.kind === 'string' ? ev.kind : undefined,
        actualKeys: ev && typeof ev === 'object' ? Object.keys(ev) : [],
        issue: parsed.error.issues[0]
          ? `${parsed.error.issues[0].path.join('.')}: ${parsed.error.issues[0].message}`
          : 'unknown',
      });
    }

    if (validEvents.length === 0) {
      return NextResponse.json({ success: true, count: 0 });
    }

    const sidecarRes = await callSidecar<MonitorSidecarResponse>(
      '/v1/monitor/events',
      {
        userId,
        events: validEvents,
      },
      { label: 'monitor /v1/monitor/events' }
    );

    return NextResponse.json({ success: true, count: sidecarRes.count ?? 0 });
  } catch (error) {
    console.error('[Monitor API] Error saving events:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
