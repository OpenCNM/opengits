import { prisma } from '@/lib/db';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { checkRateLimit } from '@/lib/rate-limit';

import { executeSidecarMarketJobAuthInfo, type JobAuthInfo } from '@/engine/market-driver';
import { projectClaimTranscribePoll } from '@/lib/state/chapter-update-state-projector';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * POST /api/update/jobs/[id]/claim-transcribe —— 认领并同步转录章节更新。
 * 认领（CAS + 积分冻结）→ 生成（认领者 BYOK）→ L0 门禁 → 暂存 → 试读投票。
 * 长转录的 HTTP 超时由认领租约 TTL 兜底（过期自动回池，冻结解除）。
 */
export const POST = defineRoute<{ id: string }>({
  scope: 'POST /api/update/jobs/[id]/claim-transcribe',
  auth: 'user',
  handler: async ({ params, userId }) => {
    // auth:'user' 已拦截未登录；此处收窄仅为类型细化（防御性，不可达）
    if (!userId) throw ApiError.unauthorized();
    if (!(await checkRateLimit(`update-claim:${userId}`, 10, 60000))) {
      throw ApiError.tooManyRequests('操作过于频繁');
    }

    const { id } = params;
    let repoForAuth: { id: string; isPublic: boolean; owner?: string; repo?: string } | null = null;
    let targetJobId = id;

    // 优先检查 id 是否为 documentId（读者在未烘焙章节页或接力推荐卡片点击「认领并转录本节」）
    const doc = await prisma.document.findUnique({
      where: { id },
      select: {
        id: true,
        path: true,
        status: true,
        repositoryId: true,
        repository: { select: { id: true, isPublic: true, relayEnabled: true, gitSha: true, owner: true, repo: true } },
      },
    });

    if (doc?.repository) {
      const { ensureRelayJobForDocument } = await import('@/lib/update-market/jobs');
      const relayJob = await ensureRelayJobForDocument(doc.id);
      targetJobId = relayJob.id;
      repoForAuth = doc.repository;
    } else {
      let jobAuth: JobAuthInfo | null = null;
      try {
        jobAuth = await executeSidecarMarketJobAuthInfo(id);
      } catch (err) {
        // 容错降级: sidecar 不可达时按未找到处理（doc 已落库路径不受影响），但必须留痕区分 5xx 与真 404
        console.warn('[claim-transcribe] sidecar job auth lookup failed:', err);
        jobAuth = null;
      }
      if (jobAuth) {
        targetJobId = jobAuth.id;
        repoForAuth = { id: jobAuth.repositoryId, isPublic: jobAuth.isPublic };
      }
    }

    if (!repoForAuth) {
      throw ApiError.notFound('任务或章节不存在');
    }
    if (!(await verifyRepoAccessDirect(repoForAuth, userId))) {
      throw ApiError.forbidden('Forbidden');
    }

    // 认领者必须有激活 BYOK 模型（转录烧自己的 key——前置检查给出清晰引导）
    const { resolveActiveUserModel } = await import('@/lib/ai/user-model-resolver');
    const model = await resolveActiveUserModel(userId);
    if (!model) {
      throw new ApiError(409, '请先在设置中配置并激活你的模型，才能参与章节转录', { code: 'NO_MODEL' });
    }

    // 检查目标任务与文档物理落库状态（第一性原理对账）
    const existingJob = await prisma.chapterUpdateJob.findUnique({
      where: { id: targetJobId },
      include: {
        document: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    }).catch(() => null);

    // 1. 幂等拦截：若底层文档已 PROCESSED 或任务已 SWAPPED/APPLIED，直接返回已落库产物
    const isAlreadySettled =
      existingJob?.status === 'SWAPPED' ||
      existingJob?.status === 'APPLIED' ||
      existingJob?.document?.status === 'PROCESSED' ||
      doc?.status === 'PROCESSED';

    if (isAlreadySettled) {
      try {
        const { chargeShelfFeeAndSave } = await import('@/lib/credits/shelf-fee');
        await chargeShelfFeeAndSave(userId, repoForAuth.id, true);
      } catch (err) {
        // 容错降级: 幂等路径补扣费失败不阻断已结算内容返回（计费可重试），但必须留痕供对账
        console.warn('[claim-transcribe] idempotent shelf-fee charge failed:', err);
      }

      const targetDocId = doc?.id || existingJob?.documentId;
      const settledDoc = targetDocId
        ? await prisma.document.findUnique({
            where: { id: targetDocId },
            select: {
              id: true,
              path: true,
              title: true,
              generationModel: true,
              content: true,
              contentRef: { select: { content: true } },
              outlineNodes: {
                select: {
                  title: true,
                  chapter: { select: { title: true } },
                },
                take: 1,
              },
              repository: {
                select: { owner: true, repo: true },
              },
            },
          }).catch(() => null)
        : null;

      const finalPath = settledDoc?.path || doc?.path || '';
      const finalTitle = settledDoc?.title || settledDoc?.outlineNodes?.[0]?.title || finalPath;
      const chapterTitle = settledDoc?.outlineNodes?.[0]?.chapter?.title || null;
      const finalOwner = settledDoc?.repository?.owner || repoForAuth.owner || '';
      const finalRepo = settledDoc?.repository?.repo || repoForAuth.repo || '';
      const finalModel = settledDoc?.generationModel || model.modelId || 'AI Model';
      const contentLength = (settledDoc?.contentRef?.content || settledDoc?.content || '').length;
      const tokensUsed = contentLength > 0 ? Math.round(contentLength * 1.5) : 2400;

      return ok({
        frozenCredits: 0,
        durationSeconds: 1,
        tokensUsed,
        model: finalModel,
        path: finalPath,
        title: finalTitle,
        chapterTitle,
        owner: finalOwner,
        repo: finalRepo,
      });
    }

    // 2. 冲突拦截：若被他人认领且租约有效，明确给出提示
    if (
      existingJob?.status === 'CLAIMED' &&
      existingJob.claimedBy &&
      existingJob.claimedBy !== userId &&
      existingJob.claimedUntil &&
      existingJob.claimedUntil > new Date()
    ) {
      throw new ApiError(409, '该章节已被其他志愿者认领正在转录中', { code: 'ALREADY_CLAIMED' });
    }

    const { claimJob, runStagedTranscription, UpdateMarketError } = await import('@/lib/update-market/jobs');
    const {
      getInFlightTranscription,
      setInFlightTranscription,
      deleteInFlightTranscription,
    } = await import('@/lib/update-market/transcription-runner');
    const startTime = Date.now();
    let frozenCredits = 0;
    try {
      // 3. 复用在途转录锁（与批量异步执行器共享的进程级 Map）：单任务 POST 撞上
      // batch 已入队的任务时复用同一 Promise——天然幂等，杜绝重复 CAS 产生 409
      let runPromise = getInFlightTranscription(targetJobId);
      if (!runPromise) {
        runPromise = (async () => {
          // 若当前用户未持有有效 CLAIMED 租约，才执行 claimJob CAS 认领；若已持有租约则直接推进转录
          if (!existingJob || existingJob.status !== 'CLAIMED' || existingJob.claimedBy !== userId) {
            const claimRes = await claimJob(targetJobId, userId);
            frozenCredits = claimRes?.frozenCredits ?? 0;
          }
          await runStagedTranscription(targetJobId);
        })();
        setInFlightTranscription(targetJobId, runPromise);
      }

      try {
        await runPromise;
      } finally {
        deleteInFlightTranscription(targetJobId);
      }

      const durationSeconds = Math.max(1, Math.round((Date.now() - startTime) / 1000));

      // 🌟 第一性原理：接力贡献者自动享有「免单入架 / 加入个人项目」权益
      // 成功完成认领转录后，原子落库 SavedRepo 并对齐书架状态
      try {
        const { chargeShelfFeeAndSave } = await import('@/lib/credits/shelf-fee');
        await chargeShelfFeeAndSave(userId, repoForAuth.id, true);
      } catch (saveErr) {
        console.warn('[claim-transcribe] Failed to auto-save repository to user shelf:', saveErr);
      }

      // 提取转录后落库的实际章节详情（用于成功庆典弹窗、阅读器直达与数据统计）
      let targetDocId = doc?.id;
      if (!targetDocId) {
        const j = await prisma.chapterUpdateJob.findUnique({
          where: { id: targetJobId },
          select: { documentId: true },
        }).catch(() => null);
        targetDocId = j?.documentId;
      }

      // 查询本次转录真实记录的 token 消耗（精确查询该用户在此转录时间窗口内的记录）
      let tokenLog: { totalTokens: number; model: string } | null = null;
      try {
        tokenLog = await prisma.tokenUsageLog.findFirst({
          where: {
            userId,
            source: 'transcription',
            createdAt: { gte: new Date(startTime - 2000) },
          },
          orderBy: { createdAt: 'desc' },
          select: { totalTokens: true, model: true },
        });
      } catch (err) {
        // 容错降级: 用量日志查询失败仅降级统计展示，不影响结算结果返回
        console.warn('[claim-transcribe] token usage log lookup failed:', err);
        tokenLog = null;
      }

      const settledDoc = targetDocId
        ? await prisma.document.findUnique({
            where: { id: targetDocId },
            select: {
              id: true,
              path: true,
              title: true,
              generationModel: true,
              content: true,
              contentRef: { select: { content: true } },
              outlineNodes: {
                select: {
                  title: true,
                  chapter: { select: { title: true } },
                },
                take: 1,
              },
              repository: {
                select: { owner: true, repo: true },
              },
            },
          }).catch(() => null)
        : null;

      const finalPath = settledDoc?.path || doc?.path || '';
      const finalTitle = settledDoc?.title || settledDoc?.outlineNodes?.[0]?.title || finalPath;
      const chapterTitle = settledDoc?.outlineNodes?.[0]?.chapter?.title || null;
      const finalOwner = settledDoc?.repository?.owner || repoForAuth.owner || '';
      const finalRepo = settledDoc?.repository?.repo || repoForAuth.repo || '';
      const finalModel = tokenLog?.model || settledDoc?.generationModel || model.modelId || 'AI Model';

      const contentLength = (settledDoc?.contentRef?.content || settledDoc?.content || '').length;
      const tokensUsed = tokenLog?.totalTokens || (contentLength > 0 ? Math.round(contentLength * 1.5) : 2400);

      return ok({
        frozenCredits,
        durationSeconds,
        tokensUsed,
        model: finalModel,
        path: finalPath,
        title: finalTitle,
        chapterTitle,
        owner: finalOwner,
        repo: finalRepo,
      });
    } catch (err) {
      if (err instanceof UpdateMarketError) {
        if (err.code === 'EMERGENCY_READONLY') {
          throw ApiError.serviceUnavailable(err.message, { code: err.code });
        }
        throw new ApiError(err.code === 'NOT_FOUND' ? 404 : 409, err.message, { code: err.code });
      }
      // L0 门禁拒绝是预期业务结果（非未知异常）：保留门禁理由原文
      const message = err instanceof Error ? err.message : 'Internal Server Error';
      if (message.includes('L0')) {
        throw ApiError.internal(`转录质量未过检：${message}`);
      }
      throw new ApiError(500, message);
    }
  },
});

/**
 * GET /api/update/jobs/[id]/claim-transcribe —— 轮询或对齐章节认领转录的最新物理事实状态。
 * 支持传入 documentId 或 ChapterUpdateJob.id。
 */
export const GET = defineRoute<{ id: string }>({
  scope: 'GET /api/update/jobs/[id]/claim-transcribe',
  auth: 'user',
  handler: async ({ params, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    const { id } = params;

    // 1. 优先尝试以 documentId 查询物理文档事实
    const doc = await prisma.document.findUnique({
      where: { id },
      select: {
        id: true,
        path: true,
        title: true,
        status: true,
        generationModel: true,
        repository: {
          select: {
            id: true,
            isPublic: true,
            owner: true,
            repo: true,
          },
        },
        outlineNodes: {
          select: {
            title: true,
            chapter: { select: { title: true } },
          },
          take: 1,
        },
      },
    });

    if (doc?.repository) {
      if (!(await verifyRepoAccessDirect(doc.repository, userId))) {
        throw ApiError.forbidden('Forbidden');
      }

      if (doc.status === 'PROCESSED') {
        return ok({
          status: 'completed' as const,
          result: {
            nodeId: doc.id,
            path: doc.path,
            title: doc.title || doc.outlineNodes?.[0]?.title || doc.path,
            chapterTitle: doc.outlineNodes?.[0]?.chapter?.title || null,
            durationSeconds: 1,
            tokensUsed: 0,
            model: doc.generationModel || 'AI Model',
            frozenCredits: 0,
            owner: doc.repository.owner,
            repo: doc.repository.repo,
          },
        });
      }

      const latestJob = await prisma.chapterUpdateJob.findFirst({
        where: { documentId: doc.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          claimedBy: true,
          claimedUntil: true,
          errorMessage: true,
          stagedModel: true,
        },
      });

      if (latestJob) {
        // 轮询三态投影收敛至纯函数（与 job-id 分支共用同一编码源；文案字面量兼容）
        const poll = projectClaimTranscribePoll({
          docProcessed: false,
          jobStatus: latestJob.status,
          claimedUntil: latestJob.claimedUntil,
          errorMessage: latestJob.errorMessage,
        });
        if (poll.status === 'completed') {
          return ok({
            status: 'completed' as const,
            result: {
              nodeId: doc.id,
              path: doc.path,
              title: doc.title || doc.outlineNodes?.[0]?.title || doc.path,
              chapterTitle: doc.outlineNodes?.[0]?.chapter?.title || null,
              durationSeconds: 1,
              tokensUsed: 0,
              model: doc.generationModel || latestJob.stagedModel || 'AI Model',
              frozenCredits: 0,
              owner: doc.repository.owner,
              repo: doc.repository.repo,
            },
          });
        }
        if (poll.status === 'running') {
          return ok({ status: 'running' as const });
        }
        return ok({ status: 'failed' as const, error: poll.error });
      }

      return ok({ status: 'failed' as const, error: '任务不存在或已失效' });
    }

    // 2. 尝试以 ChapterUpdateJob.id 查询
    const job = await prisma.chapterUpdateJob.findUnique({
      where: { id },
      include: {
        document: {
          select: {
            id: true,
            path: true,
            title: true,
            status: true,
            generationModel: true,
            outlineNodes: {
              select: {
                title: true,
                chapter: { select: { title: true } },
              },
              take: 1,
            },
          },
        },
        repository: {
          select: {
            id: true,
            isPublic: true,
            owner: true,
            repo: true,
          },
        },
      },
    });

    if (job?.repository) {
      if (!(await verifyRepoAccessDirect(job.repository, userId))) {
        throw ApiError.forbidden('Forbidden');
      }

      // 轮询三态投影收敛至纯函数（与 documentId 分支共用同一编码源）
      const poll = projectClaimTranscribePoll({
        docProcessed: job.document.status === 'PROCESSED',
        jobStatus: job.status,
        claimedUntil: job.claimedUntil,
        errorMessage: job.errorMessage,
      });
      if (poll.status === 'completed') {
        return ok({
          status: 'completed' as const,
          result: {
            nodeId: job.document.id,
            path: job.document.path,
            title: job.document.title || job.document.outlineNodes?.[0]?.title || job.document.path,
            chapterTitle: job.document.outlineNodes?.[0]?.chapter?.title || null,
            durationSeconds: 1,
            tokensUsed: 0,
            model: job.stagedModel || job.document.generationModel || 'AI Model',
            frozenCredits: 0,
            owner: job.repository.owner,
            repo: job.repository.repo,
          },
        });
      }
      if (poll.status === 'running') {
        return ok({ status: 'running' as const });
      }
      return ok({ status: 'failed' as const, error: poll.error });
    }

    throw ApiError.notFound('任务或章节不存在');
  },
});

