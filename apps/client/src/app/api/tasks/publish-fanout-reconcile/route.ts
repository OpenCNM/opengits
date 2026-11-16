import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { publishFanout } from '@/lib/review/publish-fanout';
import { acquireLease, releaseLease, leaseTtlFromIntervalMs } from '@/lib/scheduler/lease';

/**
 * POST /api/tasks/publish-fanout-reconcile —— 发布扇出定时对账（内部端点）。
 *
 * 挂载：Go worker-sidecar daemon 任务 publish-fanout-reconcile 周期 POST 本端点
 * （定时调度 100% Go 独占的登记决策不变，Node 只做被动执行体）。
 * 鉴权：x-internal-token === INTERNAL_API_TOKEN（两侧共享密钥，fail-closed）。
 * 并发防护：SchedulerLease 租约（经 Go CAS，多实例/多重入安全）。
 *
 * 对账范围（有界）：isPublic && publishedAt ≥ 24h 内 —— 扇出步骤全量幂等
 * （lib/review/publish-fanout.ts），重放即自愈；更早的漂移由
 * 进程重启（L1）、用户重试（already-public 全量扇出）覆盖。
 */

const RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECONCILE_BATCH_LIMIT = 50;
const LEASE_KEY = 'publish-fanout-reconcile';
const LEASE_INTERVAL_MS = 60 * 60 * 1000; // 调度周期 1h，TTL = 周期 × 2

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) {
    return NextResponse.json({ ok: false, error: 'INTERNAL_API_TOKEN not configured' }, { status: 503 });
  }
  const provided = req.headers.get('x-internal-token');
  if (provided !== expected) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const acquired = await acquireLease(LEASE_KEY, leaseTtlFromIntervalMs(LEASE_INTERVAL_MS));
  if (!acquired) {
    return NextResponse.json({ ok: true, skipped: 'lease-held' });
  }

  try {
    const repos = await prisma.repository.findMany({
      where: {
        isPublic: true,
        publishedAt: { gte: new Date(Date.now() - RECONCILE_WINDOW_MS) },
      },
      select: { id: true },
      orderBy: { publishedAt: 'desc' },
      take: RECONCILE_BATCH_LIMIT,
    });

    let ok = 0;
    let withFailures = 0;
    for (const repo of repos) {
      // publishFanout 内部逐步隔离：此处异常只剩 findUnique 级故障，兜底计数
      try {
        const result = await publishFanout(repo.id, 'reconcile');
        if (result.hasFailures) withFailures += 1;
        else ok += 1;
      } catch {
        withFailures += 1;
      }
    }

    return NextResponse.json({
      ok: true,
      scanned: repos.length,
      fanoutOk: ok,
      fanoutWithFailures: withFailures,
    });
  } finally {
    await releaseLease(LEASE_KEY);
  }
}
