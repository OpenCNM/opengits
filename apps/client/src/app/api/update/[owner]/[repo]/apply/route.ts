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
import { ignoreBestEffort } from '@/lib/best-effort';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export const POST = defineRoute<{ owner: string; repo: string }>({
  scope: 'POST /api/update/[owner]/[repo]/apply',
  auth: 'user',
  handler: async ({ request, params, userId }) => {
    if (!userId) throw ApiError.unauthorized();

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

    const privateDoc = await prisma.document.findFirst({
      where: { repositoryId: repository.id, ownerUserId: userId },
      select: { id: true },
    });
    const docOwnerId = privateDoc ? userId : null;

    const { plan: coercedPlan, coerced } = coercePlanDraft(plan, candidateSet);
    const totalChapters = await prisma.document.count({
      where: { repositoryId: repository.id, ownerUserId: docOwnerId },
    });
    const decision = decideExecutionStrategy(coercedPlan, candidateSet, totalChapters);

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

    let rebuildJobId: string | null = null;
    if (decision.strategy === 'MAJOR_VERSION_REBUILD') {
      const { createImportJob, scheduleImportJob } = await import('@/lib/jobs/import-job-store');

      try {
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
            preExistingRepo: { id: repository.id, isPublic: repository.isPublic },
            majorRebuildRunId: runId,
            options: {
              useAi: true,
              isPublic: repository.isPublic,
              repoProfile: repository.repoProfile,
              gitSha: run.toSha,
              starCount: repository.starCount,
            },
          },
        }
      );
      rebuildJobId = createdRebuildJobId;

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
        await callSidecar(
          '/v1/update/runs/status',
          { id: runId, status: 'PLANNED' },
          { label: 'update-runs-status-rollback' }
        ).catch(ignoreBestEffort);
        throw err;
      }

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
          ).catch(ignoreBestEffort);
          emit({
            type: 'error',
            error: error?.message || 'Failed to apply update plan',
            code: isValidation ? 'PLAN_INVALID' : 'APPLY_FAILED',
          });
          controller.close();
        }
      },
    });

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
