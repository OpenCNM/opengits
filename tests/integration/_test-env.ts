import 'dotenv/config';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';

/**
 * Shared integration environment probes (no secrets logged).
 * Fail-Closed by default: if Postgres or Go worker-sidecar is unreachable,
 * throws immediately unless SKIP_EXTERNAL_IT=1|true is explicitly set.
 */

export const ALLOW_SKIP_EXTERNAL_IT =
  process.env.SKIP_EXTERNAL_IT === '1' || process.env.SKIP_EXTERNAL_IT === 'true';

async function probeDatabase(): Promise<boolean> {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!url || !url.trim()) return false;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('DB probe timeout')), 2_000)
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function probeSidecar(): Promise<boolean> {
  const endpoint = ENGINE_CONFIG.endpoints?.workerSidecar;
  const token = process.env.INTERNAL_API_TOKEN;
  if (!endpoint || !token) return false;
  try {
    const base = endpoint.replace(/\/+$/, '');
    const res = await fetch(`${base}/healthz`, {
      signal: AbortSignal.timeout(1_500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const HAS_TEST_DB = await probeDatabase();
export const HAS_SIDECAR = await probeSidecar();

if (!ALLOW_SKIP_EXTERNAL_IT) {
  if (!HAS_TEST_DB) {
    throw new Error(
      '[Integration Fail-Closed] Postgres test database is unreachable (TEST_DATABASE_URL / DATABASE_URL). Start Postgres or set SKIP_EXTERNAL_IT=1 to explicitly skip external integration blocks.'
    );
  }
  if (!HAS_SIDECAR) {
    throw new Error(
      '[Integration Fail-Closed] Go worker-sidecar is unreachable (/healthz or INTERNAL_API_TOKEN missing). Start dev-worker-go or set SKIP_EXTERNAL_IT=1 to explicitly skip external integration blocks.'
    );
  }
} else if (!HAS_TEST_DB) {
  await prisma.$disconnect().catch(() => {});
}

export function uniqueTestTag(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createTestUser(prefix: string, overrides: Record<string, unknown> = {}) {
  const tag = uniqueTestTag(prefix);
  return prisma.user.create({
    data: {
      id: tag,
      email: `${tag}@test.local`,
      name: `Test ${prefix}`,
      ...overrides,
    },
  });
}
