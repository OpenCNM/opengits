import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { publishFanout } from '@/lib/review/publish-fanout';
import { acquireLease, releaseLease, leaseTtlFromIntervalMs } from '@/lib/scheduler/lease';

const RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECONCILE_BATCH_LIMIT = 50;
const LEASE_KEY = 'publish-fanout-reconcile';
const LEASE_INTERVAL_MS = 60 * 60 * 1000;

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
