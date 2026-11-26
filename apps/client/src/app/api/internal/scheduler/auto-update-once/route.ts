import { NextRequest, NextResponse } from 'next/server';
import { internalAuthGuard } from '@/lib/internal-auth';
import { runMarketEngineTick } from '@/lib/scheduler/auto-update';

export async function POST(req: NextRequest) {
  const denied = internalAuthGuard(req);
  if (denied) return denied;

  try {
    await runMarketEngineTick();
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, message: message.slice(0, 500) }, { status: 500 });
  }
}
