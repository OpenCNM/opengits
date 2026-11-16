import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { defineRoute } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { isEmergencyReadOnly } from '@/lib/gateway/policy';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { ENGINE_CONFIG } from '@/lib/config';
import { callSidecar } from '@/lib/sidecar-client';
import {
  applyUpdatePlan,
  coercePlanDraft,
  decideExecutionStrategy,
  UpdatePlanValidationError,
} from '@/engine/update-applier';
import { getEffectiveNavTree } from '@/lib/mcp/outline-projector';
import { isCodeChapterPath } from '@/engine/update-candidate-set';
import type { NavNode } from '@/engine/navtree-patch';
import type { UpdatePlan } from '@/engine/update-planner';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * POST /api/update/[owner]/[repo]/apply  （SSE）
 *
 * plan-then-apply 第二阶段：用户确认计划后，代码先矫正 LLM 草案（rename 接管 /
 * 幻觉 remove 矫正），再按真实删除率确定性路由（M4 + 大版本智能路由）。
 * LLM 不参与本阶段——计划来自 ImportUpdateRun 快照。
 *
 * 路由语义：
 * - INCREMENTAL_PATCH：确定性执行器原子应用（单事务），完成后上报转录统计（M6）
 * - MAJOR_VERSION_REBUILD：归档历史版本快照 → ImportJob 队列全量冷重建（配额预检
 *   不可绕过）。共享正典（docOwnerId=null）默认需 body.confirmMajorRebuild 显式确认
 *   （重建重写全部共享章节且消耗触发者配额）；私有副本自动执行。
 *
 * SSE 事件（data: JSON）：
 * - strategy_decided  { strategy, realRemoveRatio, trueRemoves, coercedActions }
 * - plan_applied  { stats }            计划应用结果（增量流）
 * - transcription_started  { codeDocs, textDocs }  待转录文档统计（增量流）
 * - major_rebuild_started { jobId }    大版本流已入队
 * - done          { success: true }
 * - error         { error, code }
 *
 * SSE 流式响应走 defineRoute 的 NextResponse 透传逃生舱（不套统一信封）；
 * 仅流式建立前的预检错误走 ApiError 失败信封（含 MAJOR_REBUILD_CONFIRM_REQUIRED：
 * run 保持 PLANNED，前端确认后携带 confirmMajorRebuild 重放）。
 */
export const POST = defineRoute<{ owner: string; repo: string }>({
  scope: 'POST /api/update/[owner]/[repo]/apply',
  auth: 'user',
  handler: async ({ request, params, userId }) => {
    // auth:'user' 已拦截未登录；此处收窄仅为类型细化（防御性，不可达）
    if (!userId) throw ApiError.unauthorized();

    // 紧急只读熔断：暂停计划应用（增量写入 / MAJOR 重建入队）（策略库故障 fail-open）
    if (await isEmergencyReadOnly()) {
      throw ApiError.serviceUnavailable('全站维护中，更新应用暂不可用，请稍后再试', {
        code: 'EMERGENCY_READONLY',
      });
    }

    const { owner, repo } = params;
    const body = await request.json().catch(() => ({}));
    const runId: string | undefined = body?.runId;
    const confirmMajorRebuild: boolean = body?.confirmMajorRebuild === true;
    if (!runId) {
      throw ApiError.badRequest('缺少 runId');
    }

    const run = await prisma.importUpdateRun.findUnique({ where: { id: runId } });
    if (!run || run.userId !== userId) {
      throw ApiError.notFound('更新计划不存在或不属于当前用户');
    }

    const repository = await prisma.repository.findUnique({
      where: { id: run.repositoryId },
    });
    if (
      !repository ||
      repository.owner.toLowerCase() !== owner.toLowerCase() ||
      repository.repo.toLowerCase() !== repo.toLowerCase()
    ) {
      throw ApiError.notFound('Repository not found');
    }

    const isAuthorized = await verifyRepoAccessDirect(repository, userId);
    if (!isAuthorized) {
      throw ApiError.forbidden('Forbidden: You do not have access to this repository');
    }
    if (run.status !== 'PLANNED') {
      throw ApiError.conflict(`更新计划状态为 ${run.status}，不可重复应用`);
    }
    if (!run.plan || !run.candidateSet) {
      throw new ApiError(422, '更新计划快照缺失');
    }

    // 0. CAS 认领（全策略统一）：并发/双击 apply 同一 run 仅一个胜出，后者 409。
    //    旧版仅 MAJOR 路径认领——增量路径无任何防护，两个并发请求都通过
    //    上方 status!==PLANNED 快照检查后同一 plan 被双应用。
    const claimedRes = await callSidecar<{ ok: boolean; claimed: boolean }>(
      '/v1/update/runs/claim',
      { id: runId },
      { label: 'update-runs-claim' }
    );
    if (!claimedRes?.claimed) {
      throw ApiError.conflict('更新计划正在应用中，请勿重复提交', { code: 'APPLY_IN_PROGRESS' });
    }

    const plan = run.plan as unknown as UpdatePlan;
    const candidateSet = run.candidateSet as unknown as Parameters<typeof applyUpdatePlan>[0]['candidateSet'];

    // 更新哪个归属的副本（与 plan 阶段判定一致）：私有行优先
    const privateDoc = await prisma.document.findFirst({
      where: { repositoryId: repository.id, ownerUserId: userId },
      select: { id: true },
    });
    const docOwnerId = privateDoc ? userId : null;

    // ── 草案矫正 + 策略路由（纯代码裁决，流式建立前完成）──
    const { plan: coercedPlan, coerced } = coercePlanDraft(plan, candidateSet);
    const totalChapters = await prisma.document.count({
      where: { repositoryId: repository.id, ownerUserId: docOwnerId },
    });
    const decision = decideExecutionStrategy(coercedPlan, candidateSet, totalChapters);

    // ── 大版本流预检：共享正典需触发者显式确认（run 保持 PLANNED，前端确认后重放）──
    const needMajorConfirm =
      decision.strategy === 'MAJOR_VERSION_REBUILD' &&
      docOwnerId === null &&
      ENGINE_CONFIG.updateEngine.majorRebuildConfirmShared;
    if (needMajorConfirm && !confirmMajorRebuild) {
      throw ApiError.conflict(
        `大版本重建将重新生成全部 ${decision.totalChapters} 个章节并消耗配额，确认后执行`,
        { code: 'MAJOR_REBUILD_CONFIRM_REQUIRED' }
      );
    }

    // ── 大版本流：快照归档 + ImportJob 入队（配额预检不可绕过）──
    // 刻意在 SSE 流建立前同步完成（长事务/配额失败直接走 ApiError 信封），
    // 流内只做状态播报——重建执行权完全移交 worker。
    let rebuildJobId: string | null = null;
    if (decision.strategy === 'MAJOR_VERSION_REBUILD') {
      const { createImportJob, scheduleImportJob } = await import('@/lib/jobs/import-job-store');

      try {
      // 1. 配额估算：基数 = 归属现存章节数（重建即全量重转录，诚实计费口径与导入一致）
      // （估算仅供 params.frozenCredits 在途配额冻结——jobs.sql 的 QUEUED/RUNNING
      //  聚合口径；结算由 Go settle 期按实际处理量计）
      const [{ getDynamicCreditsConfig, estimateRequiredCredits }, { isCodePedagogyBilling }] =
        await Promise.all([
          import('@/lib/credits-config'),
          import('@/lib/credits/import-billing'),
        ]);
      const dynamicConfig = await getDynamicCreditsConfig();
      const repoProfile = (repository.repoProfile as Record<string, unknown> | null) ?? {};
      const estimated = estimateRequiredCredits(
        {
          totalChars: decision.totalChapters * dynamicConfig.standardChunkCharSize,
          docCount: decision.totalChapters,
          isPublic: repository.isPublic,
          isCodePedagogy: isCodePedagogyBilling({
            ingestMode: (repoProfile.ingestMode as string | undefined) ?? null,
          }),
        },
        dynamicConfig
      );

      // 3. 原子入场（Go 单写者 advisory-lock 防重 + 建 Job）：不产生半截状态。
      // （frozenCredits 真实冻结值自此生效——历史 WithQuota 变体曾强制覆盖为 0，
      //  导致重建 Job 在途配额从未计入，合一后恢复 jobs.sql 的冻结口径）
      const { jobId: createdRebuildJobId } = await createImportJob(
        {
          userId,
          owner: repository.owner,
          repo: repository.repo,
          branch: repository.branch,
          edition: repository.edition,
          params: {
            userId,
            branch: repository.branch,
            edition: repository.edition,
            frozenCredits: estimated.finalCredits,
            // 回滚守卫：重建的仓已存在 → 失败绝不清理既有教程行
            preExistingRepo: { id: repository.id, isPublic: repository.isPublic },
            majorRebuildRunId: runId,
            options: {
              useAi: true,
              isPublic: repository.isPublic,
              repoProfile: repository.repoProfile,
              // 全量冷生成的目标 commit（worker 原样透传给 Go sidecar 摄取编排体）
              gitSha: run.toSha,
              starCount: repository.starCount,
            },
          },
        }
      );
      rebuildJobId = createdRebuildJobId;

      // 4. run 状态移交（非终态：执行权在 worker；失败经 Job 状态机可见）
      await callSidecar(
        '/v1/update/runs/status',
        {
          id: runId,
          status: 'MAJOR_REBUILD',
          stats: {
            strategy: decision.strategy,
            trueRemoves: decision.trueRemoves,
            realRemoveRatio: decision.realRemoveRatio,
            totalChapters: decision.totalChapters,
            coercedActions: coerced.length,
            rebuildJobId,
          },
        },
        { label: 'update-runs-status-major' }
      );
      } catch (err) {
        // 预检/入队失败：归还认领（APPLYING → PLANNED，用户可修正后重试；
        // 已落快照保留——先查后建幂等，重试复用不重复落行）
        await callSidecar(
          '/v1/update/runs/status',
          { id: runId, status: 'PLANNED' },
          { label: 'update-runs-status-rollback' }
        ).catch(() => undefined);
        throw err;
      }

      // 5. 调度（并发闸门：有空位零延迟启动，无空位 QUEUED 排队）
      await scheduleImportJob(rebuildJobId);
    }

    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event: any) => {
          try {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch (e) {
            console.error('[update/apply] Error emitting to stream', e);
          }
        };

        try {
          emit({
            type: 'strategy_decided',
            strategy: decision.strategy,
            realRemoveRatio: decision.realRemoveRatio,
            trueRemoves: decision.trueRemoves,
            coercedActions: coerced.length,
          });

          if (decision.strategy === 'MAJOR_VERSION_REBUILD') {
            emit({ type: 'major_rebuild_started', jobId: rebuildJobId });
            emit({ type: 'done', success: true });
            controller.close();
            return;
          }

          // ── 增量流：确定性应用（单事务，失败回滚）──
          const result = await applyUpdatePlan({
            repositoryId: repository.id,
            userId,
            docOwnerId,
            fromSha: run.fromSha,
            toSha: run.toSha,
            plan: coercedPlan,
            candidateSet,
            runId,
          });
          emit({ type: 'plan_applied', stats: result });

          // ── M6：转录统计（转录由打开教程页的客户端队列 / JIT 驱动，无服务端后台执行者）
          const pending = await prisma.document.findMany({
            where: { repositoryId: repository.id, ownerUserId: docOwnerId, status: 'UNPROCESSED' },
            select: { id: true, path: true },
          });
          const codeDocs = pending.filter((d) => isCodeChapterPath(d.path)).map((d) => d.id);
          const textDocs = pending.filter((d) => !isCodeChapterPath(d.path)).map((d) => d.id);

          emit({ type: 'transcription_started', codeDocs: codeDocs.length, textDocs: textDocs.length, backgroundSkipped: true });

          emit({ type: 'done', success: true });
          controller.close();
        } catch (error: any) {
          console.error('[POST /api/update/[owner]/[repo]/apply]', error);
          const isValidation = error instanceof UpdatePlanValidationError;
          await callSidecar(
            '/v1/update/runs/status',
            {
              id: runId,
              status: 'FAILED',
            },
            { label: 'update-runs-status-failed' }
          ).catch(() => {});
          emit({
            type: 'error',
            error: error?.message || 'Failed to apply update plan',
            code: isValidation ? 'PLAN_INVALID' : 'APPLY_FAILED',
          });
          controller.close();
        }
      },
    });

    // 逃生舱：SSE 流原样透传
    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  },
});

