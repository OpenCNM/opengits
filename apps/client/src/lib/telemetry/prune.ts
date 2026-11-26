import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';

export async function pruneOldTelemetryEvents(_daysToKeep: number = 30): Promise<number> {
  return 0;
}

const PRUNE_BATCH_SIZE = 5000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

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

function pruneEpisodicEvents(_cutoff: Date): Promise<number> {
  return Promise.resolve(0);
}
function pruneMcpCallLogs(_cutoff: Date): Promise<number> {
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
