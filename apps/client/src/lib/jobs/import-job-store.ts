import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { isEmergencyReadOnly } from '@/lib/gateway/policy';
import { callSidecar } from '@/lib/sidecar-client';
import {
  IMPORT_JOB_STATUS,
  isTerminalJobStatus,
  type ImportJobEventDTO,
  type ImportJobSnapshotDTO,
} from '@/lib/schemas/import-job';

/**
 * ImportJob 状态机存取层（Phase B：工作与连接解耦）。
 *
 * 职责边界：
 * - 写侧仅 worker（claim → 心跳 → 事件批量落库 → 终态），事件只追加只 INSERT；
 * - 读侧（快照/SSE）惰性执行 reap（心跳过期的 RUNNING / 卡死的 QUEUED → FAILED）
 *   与 GC（完工超 TTL 清理）——解耦架构必须重新发明"工作死亡可见"。
 */

export interface CreateImportJobInput {
  userId: string;
  owner: string;
  repo: string;
  branch: string;
  edition: string;
  /** /api/ingest 预检归一化后的完整入参（可 JSON 序列化） */
  params: Record<string, unknown>;
}

/**
 * 任务入场（第一性原理单写者收敛）：
 * 幂等查重与原子创建全面下沉至 Go Worker 单写者（Single-Writer Convergence Tail，
 * advisory-lock 防重 + 活跃任务复用）。Node 侧彻底卸载长事务、User 行锁与 DB
 * 连接占用，纯做入参透传——提交期积分准入不再经 Node（历史 _validate/
 * _requiredCredits 死参数已拆；计费在 Go settle 期结算，赚取侧 7 天质押成熟）。
 *
 * deduped=true：同 (owner,repo,branch,edition) 已有 QUEUED/RUNNING 任务，
 * Go 原子入场复用既有 Job——调用方据此短路重复 schedule（P-04 幂等契约）。
 */
export async function createImportJob(
  input: CreateImportJobInput
): Promise<{ jobId: string; deduped: boolean }> {
  const res = await callSidecar<{ id: string; deduped?: boolean }>(
    '/v1/jobs/create',
    {
      owner: input.owner,
      repo: input.repo,
      branch: input.branch,
      edition: input.edition,
      userId: input.userId || null,
      params: input.params,
    },
    { label: 'create-import-job', timeoutMs: 15_000 }
  );
  return { jobId: res.id, deduped: !!res.deduped };
}

/** 进程级 GC 节流：完工 Job 超 TTL 删除（事件级联清理），每次读取最多触发一次/窗口期 */
let lastGcAt = 0;
export async function gcFinishedImportJobs(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastGcAt < 10 * 60 * 1000) return 0;
  lastGcAt = now;
  const ttlBefore = new Date(now - ENGINE_CONFIG.jobs.finishedJobTtlDays * 24 * 60 * 60 * 1000);
  // Successful imports remain durable proof for publication after the normal job TTL.
  // Pending callbacks must survive even if another callback already granted the reward.
  return prisma.$executeRaw`
    DELETE FROM "ImportJob" AS job
    WHERE job."finishedAt" < ${ttlBefore}
      AND (
        job.status = ${IMPORT_JOB_STATUS.FAILED}
        OR (
          job.status = ${IMPORT_JOB_STATUS.COMPLETED}
          AND (job.result->>'importRewardPending') IS DISTINCT FROM 'true'
          AND (
            NULLIF(job.result->>'repositoryId', '') IS NULL
            OR EXISTS (
              SELECT 1 FROM "CreditGrantLedger" AS ledger
              WHERE ledger."repositoryId" = job.result->>'repositoryId'
                AND ledger.source = 'IMPORT_REWARD'
            )
          )
        )
      )
  `;
}

/**
 * 无鉴权内部快照读（供 SSE 订阅连接的轮询兜底用，SSE 长连接由 Go :8082 网关承载）：
 * 含排队位计算与增量事件，附带 ownerUserId 供订阅连接做内存归属比对。
 */
export async function readImportJobSnapshotInternal(
  jobId: string,
  sinceSeq = -1
): Promise<(ImportJobSnapshotDTO & { ownerUserId: string }) | null> {
  const job = await prisma.importJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      userId: true,
      owner: true,
      repo: true,
      branch: true,
      edition: true,
      status: true,
      error: true,
      finishedAt: true,
      createdAt: true,
      options: true,
    },
  });
  if (!job) return null;

  const rawProgress = (job.options as Record<string, unknown> | null)?.progressInfo;
  const progressInfo =
    rawProgress && typeof rawProgress === 'object'
      ? (rawProgress as Record<string, unknown>)
      : null;

  // 排队可见性：QUEUED 时计算前面还有几个（闸门 FIFO，按创建时间先后）
  let queuePosition: number | null = null;
  if (job.status === IMPORT_JOB_STATUS.QUEUED) {
    queuePosition = await prisma.importJob.count({
      where: {
        status: IMPORT_JOB_STATUS.QUEUED,
        createdAt: { lt: job.createdAt },
      },
    });
  }

  const events = await prisma.importJobEvent.findMany({
    where: { jobId, seq: { gt: sinceSeq } },
    orderBy: { seq: 'asc' },
    take: 500,
  });

  const lastSeqAgg = await prisma.importJobEvent.aggregate({
    where: { jobId },
    _max: { seq: true },
  });

  return {
    job: {
      id: job.id,
      owner: job.owner,
      repo: job.repo,
      branch: job.branch,
      edition: job.edition,
      status: job.status,
      error: job.error,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      lastSeq: lastSeqAgg._max.seq ?? -1,
      progressInfo,
    },
    ownerUserId: job.userId,
    events: events.map(
      (e): ImportJobEventDTO => ({
        seq: e.seq,
        type: e.type as ImportJobEventDTO['type'],
        payload: (e.payload as Record<string, unknown> | null) ?? null,
        createdAt: e.createdAt.toISOString(),
      })
    ),
    queuePosition,
  };
}

/** 读取端统一入口：鉴权（归属校验）→ 快照 + 增量事件。
 * reap 已移出读路径（P-02）：改由调度器 tick 与提交入口节流触发；GC 保持惰性。 */
export async function getImportJobSnapshot(
  jobId: string,
  viewerUserId: string,
  sinceSeq = -1
): Promise<ImportJobSnapshotDTO | null> {
  // GC 为尽力而为的清理，失败绝不影响读取（防未处理拒绝打崩进程）
  gcFinishedImportJobs().catch((err) => {
    void import('@/lib/observability/errors').then((m) =>
      m.captureError(err, { scope: 'import-job-store/gc' })
    );
  });

  const snap = await readImportJobSnapshotInternal(jobId, sinceSeq);
  if (!snap || snap.ownerUserId !== viewerUserId) return null;

  const { ownerUserId: _ownerUserId, ...rest } = snap;
  void _ownerUserId;
  return rest;
}

export { isTerminalJobStatus };

// ─────────────────────────────────────────────────────────────
// 调度（2026-10 收口）：Node 进程内执行器与泵双轨已退役——ImportJob 执行、
// 认领（SKIP LOCKED）、reap、GC 100% 由 Go jobs Runner 单写者承载。
// scheduleImportJob 收缩为"唤醒 Go 泵"薄封装：入队即时拾取（tick 3s 兜底）。
// ─────────────────────────────────────────────────────────────

/**
 * 提交执行入口：唤醒 Go worker-sidecar 调度泵即时拾取（吞错——
 * 唤醒失败仅损失即时性，3s tick 兜底；jobId 仅作日志关联）。
 */
export async function scheduleImportJob(jobId: string): Promise<void> {
  void jobId;
  try {
    await callSidecar('/v1/jobs/enqueue-pump', {}, { label: 'jobs-enqueue-pump', timeoutMs: 3_000 });
  } catch {
    // 唤醒尽力而为：tick 兜底
  }
}
