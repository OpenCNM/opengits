import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';

/**
 * Prune historical EpisodicEvent telemetry records older than `daysToKeep` days.
 * Keeps the database compact and permanently prevents telemetry bloat.
 *
 * @param daysToKeep Number of days of telemetry data to retain (default: 30)
 * @returns Number of deleted records
 */
export async function pruneOldTelemetryEvents(_daysToKeep: number = 30): Promise<number> {
  // 单写者收敛（Phase 14）：EpisodicEvent 的流水修剪已完全由 Go worker-sidecar 常驻调度器接管
  return 0;
}

/** 单表分批删除的批次大小：先按主键选 id 再 deleteMany in，避免长事务锁全表 */
const PRUNE_BATCH_SIZE = 5000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * 分批删除循环：每轮选出最多 PRUNE_BATCH_SIZE 条主键再按主键 deleteMany
 * （命中索引、短事务），循环至清空。count < rows（并发写入被删）也终止。
 */
async function deleteInBatches(
  pickIds: (take: number) => Promise<Array<{ id: string }>>,
  deleteIds: (ids: string[]) => Promise<{ count: number }>,
): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await pickIds(PRUNE_BATCH_SIZE);
    if (rows.length === 0) break;
    const result = await deleteIds(rows.map((r) => r.id));
    total += result.count;
    if (result.count < rows.length) break;
  }
  return total;
}

// 各表委托以具体引用传入（Prisma 委托联合类型不可直接索引调用），分批循环统一抽象。
function pruneEpisodicEvents(_cutoff: Date): Promise<number> {
  // 单写者收敛（Phase 14）：已完全由 Go worker-sidecar 常驻调度器接管
  return Promise.resolve(0);
}
function pruneMcpCallLogs(_cutoff: Date): Promise<number> {
  // 单写者收敛（Phase 14）：已完全由 Go worker-sidecar 常驻调度器接管
  return Promise.resolve(0);
}
function pruneTokenUsageLogs(cutoff: Date): Promise<number> {
  return deleteInBatches(
    (take) => prisma.tokenUsageLog.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take }),
    (ids) => prisma.tokenUsageLog.deleteMany({ where: { id: { in: ids } } }),
  );
}
function pruneAdminAuditLogs(cutoff: Date): Promise<number> {
  return deleteInBatches(
    (take) => prisma.adminAuditLog.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take }),
    (ids) => prisma.adminAuditLog.deleteMany({ where: { id: { in: ids } } }),
  );
}
function pruneGatewaySecurityEvents(cutoff: Date): Promise<number> {
  return deleteInBatches(
    (take) => prisma.gatewaySecurityEvent.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take }),
    (ids) => prisma.gatewaySecurityEvent.deleteMany({ where: { id: { in: ids } } }),
  );
}

/**
 * 全量流水表保留期清理（调度器每轮调用；各表独立 try/catch，单表失败不拖垮整轮）。
 * 覆盖：EpisodicEvent / McpCallLog / TokenUsageLog / AdminAuditLog /
 * GatewaySecurityEvent（createdAt）与 Session（expires < now 即时回收）。
 * 刻意不含 ConversationMessage——聊天记录是用户数据而非流水。
 */
export async function runRetentionPrune(): Promise<Record<string, number>> {
  const { retention } = ENGINE_CONFIG;
  const report: Record<string, number> = {};

  const tasks: Array<{ key: string; run: () => Promise<number> }> = [
    { key: 'episodicEvent', run: () => pruneEpisodicEvents(daysAgo(retention.episodicDays)) },
    { key: 'mcpCallLog', run: () => pruneMcpCallLogs(daysAgo(retention.mcpCallLogDays)) },
    { key: 'tokenUsageLog', run: () => pruneTokenUsageLogs(daysAgo(retention.tokenUsageDays)) },
    { key: 'adminAuditLog', run: () => pruneAdminAuditLogs(daysAgo(retention.adminAuditDays)) },
    {
      key: 'gatewaySecurityEvent',
      run: () => pruneGatewaySecurityEvents(daysAgo(retention.gatewayEventDays)),
    },
    {
      key: 'sessionExpired',
      run: () =>
        prisma.session
          .deleteMany({ where: { expires: { lt: new Date() } } })
          .then((r) => r.count),
    },
  ];

  for (const task of tasks) {
    try {
      report[task.key] = await task.run();
    } catch (error) {
      console.error(`[TelemetryPrune] Failed to prune ${task.key}:`, error);
      report[task.key] = -1;
    }
  }

  console.log('[TelemetryPrune] retention prune report:', JSON.stringify(report));
  return report;
}
