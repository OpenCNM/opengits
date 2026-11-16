import { NextRequest, NextResponse } from 'next/server';
import { getSessionHelper } from "@/lib/auth-helper";
import { checkRateLimit } from '@/lib/rate-limit';
import { callSidecar } from '@/lib/sidecar-client';
import { TELEMETRY_EVENTS } from '@/lib/telemetry/beacon';

// 批量上报护栏：单批事件上限 + 每用户频率上限（防 DB 膨胀 / 恶意刷写）
const MAX_EVENTS_PER_BATCH = 50;
const TELEMETRY_RATE_LIMIT = 30; // 批/分钟

interface TelemetrySidecarResponse {
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

    if (!(await checkRateLimit(`telemetry:${userId}`, TELEMETRY_RATE_LIMIT, 60000))) {
      return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
    }

    const body = await req.json();
    const { events } = body;

    if (!Array.isArray(events) || events.length === 0) {
      return NextResponse.json({ success: true, count: 0 });
    }

    const ALLOWED_EVENT_TYPES = new Set<string>(Object.values(TELEMETRY_EVENTS));
    const validEvents = events
      .slice(0, MAX_EVENTS_PER_BATCH)
      .filter((ev: any) => ev && typeof ev.eventType === 'string' && ALLOWED_EVENT_TYPES.has(ev.eventType));

    if (validEvents.length === 0) {
      return NextResponse.json({ success: true, count: 0 });
    }

    const sidecarRes = await callSidecar<TelemetrySidecarResponse>(
      '/v1/telemetry/events',
      {
        userId,
        events: validEvents,
      },
      { label: 'telemetry /v1/telemetry/events' }
    );

    return NextResponse.json({ success: true, count: sidecarRes.count ?? 0 });
  } catch (error) {
    console.error('[Telemetry API] Error saving events:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}


