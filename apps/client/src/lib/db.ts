import { Prisma, PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

/**
 * 查询日志开关：
 * - 生产环境默认关闭——逐查询打印完整 SQL 是显著的日志噪声与性能负担
 * - 非生产默认开启（保留既有调试体验），可用 PRISMA_QUERY_LOG=false 显式关闭
 *   （如跑 smoke 套件 / 基准脚本，避免日志刷屏）
 */
const prismaClientOptions: Prisma.PrismaClientOptions = {
  log:
    process.env.NODE_ENV !== 'production' && process.env.PRISMA_QUERY_LOG !== 'false'
      ? ['query']
      : [],
};

function getPrismaClient(): PrismaClient {
  if (globalForPrisma.prisma) {
    if (process.env.NODE_ENV !== 'production' && !('userReadingProgress' in globalForPrisma.prisma)) {
      globalForPrisma.prisma = new PrismaClient(prismaClientOptions);
    }
    return globalForPrisma.prisma;
  }
  const client = new PrismaClient(prismaClientOptions);
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = client;
  }
  return client;
}

export const prisma = getPrismaClient();
