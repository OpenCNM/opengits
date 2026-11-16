import { PrismaClient } from '@prisma/client';
import { prisma as primary } from '@/lib/db';

/**
 * ─────────────────────────────────────────────────────────────
 * 只读副本接缝（Phase 3 #5，可选）。
 *
 * 配置 DATABASE_REPLICA_URL 后，重查询（explore/stats/report 类聚合）
 * 可经 getReadDb() 落到只读副本；未配置时返回主库实例——调用点零分支。
 *
 * 约定：
 * - 仅限读查询；任何写入走主库 `prisma`
 * - 复制延迟敏感的读（如「写入后立即可见」交互）不要使用本接缝
 * - 生产建议前置 PgBouncer（transaction pooling）；连接串写入 DATABASE_REPLICA_URL 并附 connection_limit 参数
 * ─────────────────────────────────────────────────────────────
 */

const globalForReplica = globalThis as unknown as {
  __opengitsReplica: PrismaClient | undefined;
};

const REPLICA_URL = process.env.DATABASE_REPLICA_URL || '';

export function getReadDb(): PrismaClient {
  if (!REPLICA_URL) return primary;
  if (!globalForReplica.__opengitsReplica) {
    globalForReplica.__opengitsReplica = new PrismaClient({
      datasources: { db: { url: REPLICA_URL } },
    });
  }
  return globalForReplica.__opengitsReplica;
}
