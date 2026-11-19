import { prisma } from '@/lib/db';
import { callSidecar } from '@/lib/sidecar-client';
import { publishFanout } from '@/lib/review/publish-fanout';
import {
  getPublicationContent,
  publicationSnapshot,
  sharePublicationDocuments,
} from '@/lib/credits/import-reward';
import { resolveMaintainerUserId } from '@/lib/repository-maintainer';
import { computePipelineScore, type PipelineScore } from '@/lib/review/pipeline-score';
import { reviewTutorialByPlatform } from '@/lib/review/platform-review';
import type { LlmReviewResult } from '@/lib/review/llm-review';
import { decideReview } from '@/lib/review/decision';

let isCycleRunning = false;
/**
 * 跳过已留审且内容与审核基准均未变化的条目，避免前 10 条留审项堵死队列并每 30 秒刷屏日志。
 * key: repositoryId, value: `${repo.updatedAt.toISOString()}|${reviewConfigUpdatedAt}`
 */
const heldSignatureCache = new Map<string, string>();
const MAX_LLM_EVALS_PER_CYCLE = 10;

export interface AutoReviewLogItem {
  id: string;
  action: string;
  target: string;
  details: Record<string, any>;
  createdAt: string;
}

export interface AutoReviewDaemonStatus {
  enabled: boolean;
  isRunning: boolean;
  lastRunAt: string | null;
  logs: AutoReviewLogItem[];
  stats: {
    totalApproved: number;
    totalHeld: number;
    totalFailed: number;
  };
}

/** 获取无人值守开关状态（基于 AdminAuditLog 事实表） */
export async function getAutoReviewDaemonEnabled(): Promise<boolean> {
  try {
    const lastToggle = await prisma.adminAuditLog.findFirst({
      where: { action: 'AUTO_REVIEW_DAEMON_TOGGLE' },
      orderBy: { createdAt: 'desc' },
      select: { detailsJson: true },
    });
    return (lastToggle?.detailsJson as any)?.enabled ?? false;
  } catch (err) {
    // 容错降级: 读取开关记录异常时默认关闭
    console.warn('[AutoReviewDaemon] failed to read toggle state:', err);
    return false;
  }
}

/** 切换无人值守开关状态 */
export async function setAutoReviewDaemonEnabled(
  enabled: boolean,
  adminUserId?: string,
  adminEmail?: string
): Promise<boolean> {
  await prisma.adminAuditLog.create({
    data: {
      adminUserId: adminUserId || null,
      action: 'AUTO_REVIEW_DAEMON_TOGGLE',
      target: 'AutoReviewDaemon',
      detailsJson: {
        enabled,
        operatorEmail: adminEmail || 'admin',
        updatedAt: new Date().toISOString(),
      },
    },
  });
  return enabled;
}

/** 获取状态、运行指标与日志 */
export async function getAutoReviewDaemonStatus(): Promise<AutoReviewDaemonStatus> {
  const [enabled, rawLogs, totalApproved, totalHeld, totalFailed] = await Promise.all([
    getAutoReviewDaemonEnabled(),
    prisma.adminAuditLog.findMany({
      where: {
        action: {
          in: [
            'AUTO_REVIEW_DAEMON_TOGGLE',
            'AUTO_REVIEW_APPROVED',
            'AUTO_REVIEW_HELD',
            'AUTO_REVIEW_FAIL',
            'AUTO_REVIEW_CYCLE_SUMMARY',
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 60,
    }),
    prisma.adminAuditLog.count({ where: { action: 'AUTO_REVIEW_APPROVED' } }),
    prisma.adminAuditLog.count({ where: { action: 'AUTO_REVIEW_HELD' } }),
    prisma.adminAuditLog.count({ where: { action: 'AUTO_REVIEW_FAIL' } }),
  ]);

  const lastRunLog = rawLogs.find((l) => l.action !== 'AUTO_REVIEW_DAEMON_TOGGLE');

  const logs: AutoReviewLogItem[] = rawLogs.map((l) => ({
    id: l.id,
    action: l.action,
    target: l.target || '系统',
    details: (l.detailsJson as Record<string, any>) || {},
    createdAt: l.createdAt.toISOString(),
  }));

  return {
    enabled,
    isRunning: isCycleRunning,
    lastRunAt: lastRunLog ? lastRunLog.createdAt.toISOString() : null,
    logs,
    stats: {
      totalApproved,
      totalHeld,
      totalFailed,
    },
  };
}

/** 事务内安全发布通过（防并发竞争 + 幂等扇出） */
async function approveRepositoryTx(
  repository: { id: string; owner: string; repo: string; reviewPipeline: any },
  adminUserId?: string,
  reasonText = '无人值守自动审核通过并公开'
) {
  let alreadyApproved = false;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Repository" WHERE id = ${repository.id} FOR UPDATE`;
    const current = await tx.repository.findUnique({ where: { id: repository.id } });
    if (!current) throw new Error('Repository not found');
    if (current.reviewStatus === 'APPROVED') {
      alreadyApproved = true;
      return;
    }
    if (current.reviewStatus !== 'PENDING') throw new Error('Review state changed');

    let publication = publicationSnapshot(current.reviewPipeline);
    if (!publication) {
      const maintainerId = (await resolveMaintainerUserId(repository.id)) || (current as any).userId;
      if (maintainerId) {
        const content = await getPublicationContent(tx, repository.id, maintainerId);
        if (content.ready) {
          publication = { userId: maintainerId, contentHash: content.contentHash };
        }
      }
    }
    if (!publication) throw new Error('未包含有效发布快照，请重新提交发布审核');

    const content = await getPublicationContent(tx, repository.id, publication.userId);
    if (!content.ready || content.contentHash !== publication.contentHash) {
      throw new Error('内容已变化，请重新提交发布审核');
    }

    await sharePublicationDocuments(tx, repository.id, publication.userId);
    await tx.adminAuditLog.create({
      data: {
        adminUserId: adminUserId || null,
        action: 'REVIEW_APPROVE',
        target: `${repository.owner}/${repository.repo}`,
        detailsJson: { reason: reasonText, isAutoApproved: true },
      },
    });
  });

  if (alreadyApproved) return;

  await callSidecar(
    '/v1/repos/patch',
    {
      id: repository.id,
      isPublic: true,
      reviewStatus: 'APPROVED',
      reviewAutoApproved: true,
      clearRejectionReason: true,
      touchReviewedAt: true,
      touchPublishedAt: true,
    },
    { label: 'auto review approve' }
  );

  await publishFanout(repository.id, 'admin-approve');
}

/**
 * 执行一轮无人值守自动审核循环：
 * 1. 扫描 reviewStatus === 'PENDING' 的待审教程
 * 2. 依次补齐 AST 管线分与 LLM 初审判定
 * 3. 运行 decideReview 规则引擎
 * 4. 达标项自动公开 + 写审计日志；留审项写原因日志
 */
export async function runAutoReviewCycle(options?: {
  adminUserId?: string;
  force?: boolean;
}): Promise<{
  scanned: number;
  approved: number;
  held: number;
  failed: number;
  message: string;
}> {
  if (isCycleRunning) {
    return {
      scanned: 0,
      approved: 0,
      held: 0,
      failed: 0,
      message: '上一轮无人值守审核正在运行中，跳过本次重入',
    };
  }

  const enabled = options?.force ? true : await getAutoReviewDaemonEnabled();
  if (!enabled) {
    return {
      scanned: 0,
      approved: 0,
      held: 0,
      failed: 0,
      message: '无人值守守护已停用',
    };
  }

  isCycleRunning = true;
  const startTime = Date.now();
  let scanned = 0;
  let approved = 0;
  let held = 0;
  let failed = 0;

  try {
    const pendingItems = await prisma.repository.findMany({
      where: { reviewStatus: 'PENDING' },
      select: {
        id: true,
        owner: true,
        repo: true,
        updatedAt: true,
        reviewPipeline: true,
        reviewLlm: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 100,
    });

    if (pendingItems.length === 0) {
      return {
        scanned: 0,
        approved: 0,
        held: 0,
        failed: 0,
        message: '待审队列为空，巡检完成',
      };
    }

    // 读平台基准线配置
    const reviewConfig = await prisma.platformReviewConfig
      .findUnique({ where: { id: 'singleton' } })
      .catch((err) => {
        // 容错降级: 平台审核配置未就绪或临时不可达时采用系统默认基准
        console.warn('[AutoReviewDaemon] failed to load review config, falling back to defaults:', err);
        return null;
      });
    const thresholds = {
      pipelinePass: reviewConfig?.pipelinePassThreshold ?? 70,
      llmPass: reviewConfig?.llmPassThreshold ?? 75,
      confidenceMin: reviewConfig?.confidenceThreshold ?? 0.7,
      enforceQualityGate: reviewConfig?.enforceQualityGate ?? false,
    };
    const configVersion = reviewConfig?.updatedAt ? reviewConfig.updatedAt.toISOString() : 'default';

    let llmEvalsThisCycle = 0;

    for (const item of pendingItems) {
      const repoRef = `${item.owner}/${item.repo}`;
      const existingLlm = item.reviewLlm as LlmReviewResult | null;
      const needsLlmEval = !existingLlm || (existingLlm as any).unavailable;
      const itemSignature = `${item.updatedAt.toISOString()}|${configVersion}`;

      // 非强制巡检时，跳过已判定留审且教程内容与基线均未变化的条目，防止前序留审项堵死队列
      if (!options?.force && !needsLlmEval && heldSignatureCache.get(item.id) === itemSignature) {
        continue;
      }

      if (needsLlmEval && llmEvalsThisCycle >= MAX_LLM_EVALS_PER_CYCLE) {
        continue;
      }

      scanned++;
      try {
        // 1. 确保管线分可用
        let pipelineScore = item.reviewPipeline as unknown as PipelineScore | null;
        if (!pipelineScore || (pipelineScore as any).unavailable || !pipelineScore.total) {
          pipelineScore = await computePipelineScore(item.id);
          await callSidecar(
            '/v1/repos/patch',
            { id: item.id, reviewPipeline: pipelineScore as any },
            { label: 'auto review pipeline patch' }
          );
        }

        // 2. 补齐 LLM 评估
        let llmReview = existingLlm;
        if (needsLlmEval) {
          llmEvalsThisCycle++;
          llmReview = await reviewTutorialByPlatform(item.id, undefined, { timeoutMs: 120000 });
          if (llmReview.unavailable) {
            failed++;
            await prisma.adminAuditLog.create({
              data: {
                adminUserId: options?.adminUserId || null,
                action: 'AUTO_REVIEW_FAIL',
                target: repoRef,
                detailsJson: {
                  error: llmReview.summary || '初审通道调用失败',
                  concerns: llmReview.concerns,
                  timestamp: new Date().toISOString(),
                },
              },
            });
            continue;
          }

          // 评估成功，持久化 reviewLlm
          await callSidecar(
            '/v1/repos/patch',
            { id: item.id, reviewLlm: llmReview as any },
            { label: 'auto review llm patch' }
          );
        }

        // 3. 运行裁决引擎
        const decision = decideReview(pipelineScore, llmReview!, thresholds);

        if (decision.action === 'AUTO_PUBLISH') {
          heldSignatureCache.delete(item.id);
          await approveRepositoryTx(item, options?.adminUserId, '无人值守自动评估达标公开');
          approved++;
          await prisma.adminAuditLog.create({
            data: {
              adminUserId: options?.adminUserId || null,
              action: 'AUTO_REVIEW_APPROVED',
              target: repoRef,
              detailsJson: {
                pipelineScore: pipelineScore.total,
                llmScore: llmReview!.overallScore,
                confidence: llmReview!.confidence,
                archetype: llmReview!.archetype,
                rationale: decision.rationale,
                status: 'APPROVED',
                timestamp: new Date().toISOString(),
              },
            },
          });
        } else {
          heldSignatureCache.set(item.id, itemSignature);
          held++;
          await prisma.adminAuditLog.create({
            data: {
              adminUserId: options?.adminUserId || null,
              action: 'AUTO_REVIEW_HELD',
              target: repoRef,
              detailsJson: {
                pipelineScore: pipelineScore.total,
                llmScore: llmReview!.overallScore,
                confidence: llmReview!.confidence,
                safetyFlag: llmReview!.safetyFlag,
                concerns: llmReview!.concerns,
                rationale: decision.rationale,
                status: 'HELD',
                timestamp: new Date().toISOString(),
              },
            },
          });
        }
      } catch (itemErr: any) {
        failed++;
        console.error(`[AutoReview] error processing ${repoRef}:`, itemErr);
        await prisma.adminAuditLog.create({
          data: {
            adminUserId: options?.adminUserId || null,
            action: 'AUTO_REVIEW_FAIL',
            target: repoRef,
            detailsJson: {
              error: itemErr instanceof Error ? itemErr.message : String(itemErr),
              timestamp: new Date().toISOString(),
            },
          },
        });
      }
    }

    const durationMs = Date.now() - startTime;
    if (scanned > 0 || options?.force) {
      await prisma.adminAuditLog.create({
        data: {
          adminUserId: options?.adminUserId || null,
          action: 'AUTO_REVIEW_CYCLE_SUMMARY',
          target: 'System',
          detailsJson: {
            scanned,
            approved,
            held,
            failed,
            durationMs,
            timestamp: new Date().toISOString(),
          },
        },
      });
    }

    return {
      scanned,
      approved,
      held,
      failed,
      message: `无人值守巡检完成：扫描 ${scanned} 篇，自动公开 ${approved} 篇，留审 ${held} 篇，异常 ${failed} 篇（耗时 ${(
        durationMs / 1000
      ).toFixed(1)}s）`,
    };
  } finally {
    isCycleRunning = false;
  }
}
