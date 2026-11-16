import { NextRequest, NextResponse } from 'next/server';
import { internalAuthGuard } from '@/lib/internal-auth';
import { runPlatformReviewPatrol } from '@/lib/review/review-patrol';

/**
 * 平台每日凌晨评分巡检端点 (Nightly Platform Review Patrol Endpoint)
 *
 * 由内部定时器（Cron / Scheduler）或管理后台调用，
 * 扫描公开教程中“异常高分”、“异常低分”或“所有者近期重评待复核”的版本，
 * 携带历史审评记忆执行中立校准，并记录全过程与原因留痕。
 *
 * POST /api/internal/scheduler/review-patrol
 */
export async function POST(req: NextRequest) {
  const denied = internalAuthGuard(req);
  if (denied) return denied;

  try {
    let body: { dryRun?: boolean; limit?: number } = {};
    try {
      body = await req.json();
    } catch {
      // 容错空 body
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
