import { NextResponse } from 'next/server';
import fs from 'fs-extra';
import path from 'path';
import { prisma } from '@/lib/db';
import { TARBALL_CACHE } from '@/lib/config';

import { withTimeout } from '@/lib/health-probe';

export const dynamic = 'force-dynamic';

export async function GET() {
  const startedAt = Date.now();
  const checks: Record<string, 'ok' | 'fail'> = {};
  let healthy = true;

  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 3000);
    checks.db = 'ok';
  } catch (err) {
    console.error('[Health] DB ping failed or timed out:', err);
    checks.db = 'fail';
    healthy = false;
  }

  try {
    await withTimeout(async () => {
      await fs.ensureDir(TARBALL_CACHE.dir);
      const probe = path.join(TARBALL_CACHE.dir, `.health-probe-${process.pid}`);
      await fs.writeFile(probe, 'ok');
      await fs.remove(probe);
    }, 3000);
    checks.storage = 'ok';
  } catch (err) {
    console.error('[Health] storage check failed or timed out:', err);
    checks.storage = 'fail';
    healthy = false;
  }

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      checks,
      uptimeSeconds: Math.round(process.uptime()),
      latencyMs: Date.now() - startedAt,
    },
    { status: healthy ? 200 : 503 }
  );
}
