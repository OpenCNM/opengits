import { PrismaClient } from '@prisma/client';
import { prisma as primary } from '@/lib/db';

const globalForReplica = globalThis as unknown as {
  __opengitsReplica: PrismaClient | undefined;
};

const REPLICA_URL = process.env.DATABASE_REPLICA_URL || '';

// Optional read-replica seam; avoid on read-after-write flows sensitive to replication lag.
export function getReadDb(): PrismaClient {
  if (!REPLICA_URL) return primary;
  if (!globalForReplica.__opengitsReplica) {
    globalForReplica.__opengitsReplica = new PrismaClient({
      datasources: { db: { url: REPLICA_URL } },
    });
  }
  return globalForReplica.__opengitsReplica;
}
