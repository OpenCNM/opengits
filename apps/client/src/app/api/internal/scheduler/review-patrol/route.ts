import { NextRequest, NextResponse } from 'next/server';
import { internalAuthGuard } from '@/lib/internal-auth';
import { runPlatformReviewPatrol } from '@/lib/review/review-patrol';

export async function POST(req: NextRequest) {
  const denied = internalAuthGuard(req);
  if (denied) return denied;

  try {
    let body: { dryRun?: boolean; limit?: number } = {};
    try {
      body = await req.json();
    } catch {
    }

    const report = await runPlatformReviewPatrol({
      dryRun: Boolean(body.dryRun),
      limit: typeof body.limit === 'number' ? body.limit : undefined,
    });

    return NextResponse.json({ ok: true, report });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ReviewPatrolRoute] 巡检执行失败:', message);
    return NextResponse.json({ ok: false, message: message.slice(0, 500) }, { status: 500 });
  }
}
