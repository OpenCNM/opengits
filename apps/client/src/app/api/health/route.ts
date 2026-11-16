import { NextResponse } from 'next/server';
import fs from 'fs-extra';
import path from 'path';
import { prisma } from '@/lib/db';
import { TARBALL_CACHE } from '@/lib/config';

import { withTimeout } from '@/lib/health-probe';

export const dynamic = 'force-dynamic';

/**
 * 健康检查：DB 连通 + storage 可写。
 * Docker 部署的存活/就绪探针与运维排障入口。
 */
export async function GET() {
  const startedAt = Date.now();
  const checks: Record<string, 'ok' | 'fail'> = {};
  let healthy = true;

  // 1. Database ping (3000ms timeout)
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 3000);
    checks.db = 'ok';
  } catch (err) {
    console.error('[Health] DB ping failed or timed out:', err);
    checks.db = 'fail';
    healthy = false;
  }

  // 2. Archive cache dir writable（归档落盘依赖，3000ms timeout）
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
