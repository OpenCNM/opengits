import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { ENGINE_CONFIG } from '@/lib/config';
import { callSidecar } from '@/lib/sidecar-client';
import { getActiveOutline, allChaptersInTeachingOrder } from '@/lib/outline-reader';
import { buildUpdateCandidateSet } from '@/engine/update-candidate-set';
import { generateUpdatePlan, conservativePlan } from '@/engine/update-planner';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

/**
 * POST /api/update/[owner]/[repo]/plan
 *
 * plan-then-apply 第一阶段：规则候选集（M2）+ LLM 计划（M3），生成待用户确认的更新计划。
 * 不写任何文档数据；仅创建 ImportUpdateRun(PLANNED) 快照供审计与 apply 阶段消费。
 *
 * 降级链：LLM 计划失败 → conservativePlan（候选集全量更新，宁多勿少）。
 * 无变更（diff 未命中任何被转录内容）→ 返回 { noChanges: true }，不建 run。
 */
export const POST = defineRoute<{ owner: string; repo: string }>({
  scope: 'POST /api/update/[owner]/[repo]/plan',
  auth: 'user',
  handler: async ({ request, params, userId }) => {
    // auth:'user' 已拦截未登录；此处收窄仅为类型细化（防御性，不可达）
    if (!userId) throw ApiError.unauthorized();

    const { owner, repo } = params;
    const url = new URL(request.url);
    const queryBranch = url.searchParams.get('branch')?.trim();
    const queryEdition = url.searchParams.get('edition');

    let bodyBranch: string | undefined;
    let bodyEdition: string | undefined;
    try {
      const body = await request.clone().json();
      if (body && typeof body === 'object') {
        if (typeof body.branch === 'string' && body.branch.trim()) bodyBranch = body.branch.trim();
        if (typeof body.edition === 'string') bodyEdition = body.edition;
      }
    } catch {}

    const requestedBranch = queryBranch || bodyBranch || undefined;
    const requestedEdition = queryEdition !== null ? queryEdition : (bodyEdition !== undefined ? bodyEdition : undefined);

    const { resolveRepository } = await import('@/lib/repository-resolver');
    const resolved = await resolveRepository(owner, repo, requestedBranch, requestedEdition);
    if (!resolved || !resolved.repository) {
      throw ApiError.notFound('Repository not found');
    }
    // 类型化讲法未命中（fail-closed）：显式请求的讲法不存在时严禁静默落到基础行——
    // 否则行级 SavedRepo 鉴权与变更操作都会落在错误讲法的行上
    if (requestedEdition && resolved.editionMiss) {
      throw new ApiError(404, '请求的讲法不存在或已下线', { code: 'EDITION_NOT_FOUND' });
    }
    const repository = resolved.repository;
    const targetBranch = resolved.resolvedBranch || repository.branch || ENGINE_CONFIG.defaultBranch;

    const isAuthorized = await verifyRepoAccessDirect(repository, userId);
    if (!isAuthorized) {
      throw ApiError.forbidden('Forbidden: You do not have access to this repository');
    }

    // ── fromSha：用户冻结于哪个 commit（ImportRecord 为准，回退 repository.gitSha）──
    let record = await prisma.importRecord.findUnique({
      where: {
        userId_repositoryId_branch: { userId, repositoryId: repository.id, branch: targetBranch },
      },
      select: { sha: true },
    });
    if (!record) {
      record = await prisma.importRecord.findFirst({
        where: { repositoryId: repository.id, branch: targetBranch },
        orderBy: { createdAt: 'desc' },
        select: { sha: true },
      });
    }
    const fromSha = record?.sha || repository.gitSha;
    if (!fromSha) {
      throw ApiError.conflict('未找到导入记录，请先导入该仓库', { code: 'NO_IMPORT' });
    }

    // ── toSha：上游最新 commit ──
    const { resolveLatestSha, fetchCompareDiff } = await import('@/engine/repo-tarball');
    const toSha = await resolveLatestSha(owner, repo, targetBranch);
    if (fromSha === toSha) {
      throw ApiError.conflict('教程已是最新版本', { code: 'NO_UPDATE', detail: toSha });
    }

    // ── 轻量 Diff 优先（毫秒级 Compare API，避免下载数十 MB 全量 Tarball）──
    const { resolveGithubToken } = await import('@/lib/github/token-resolver');
    const githubToken = await resolveGithubToken(userId);
    const compareDiff = await fetchCompareDiff(owner, repo, fromSha, toSha, githubToken);

    // ── 更新哪个归属的副本：私有行优先（真冻结），否则共享行 ──
    const privateDoc = await prisma.document.findFirst({
      where: { repositoryId: repository.id, ownerUserId: userId },
      select: { id: true },
    });
    const docOwnerId = privateDoc ? userId : null;

    // ── Stage 0：候选集（若 compareDiff 可用直接基于轻量 diff 计算；不可用时内部回退本地归档）──
    let candidateSet;
    try {
      candidateSet = await buildUpdateCandidateSet({
        owner,
        repo,
        branch: targetBranch,
        fromSha,
        toSha,
        repositoryId: repository.id,
        docOwnerId,
        repoProfile: repository.repoProfile as Record<string, unknown> | null,
        diff: compareDiff,
        token: githubToken,
      });
    } catch (err) {
      throw new ApiError(422, err instanceof Error ? err.message : '增量 diff 不可用（归档缺失或仓库超限），建议强制重新导入', {
        code: 'DIFF_UNAVAILABLE',
      });
    }
    if (!candidateSet) {
      throw new ApiError(422, '增量 diff 不可用（归档缺失或仓库超限），建议使用强制全量重新导入', {
        code: 'DIFF_UNAVAILABLE',
      });
    }

    // ── 无任何被转录内容受影响 → 无需更新 ──
    if (candidateSet.chapters.length === 0 && candidateSet.unmatchedFiles.length === 0) {
      return ok({
        noChanges: true,
        diffStats: candidateSet.diffStats,
        message: '上游有更新，但未涉及教程转录内容',
      });
    }

    // ── 现有章节顺序（供 LLM 参考与展示）──
    const profile = (repository.repoProfile as Record<string, unknown> | null) ?? {};
    const clusters = (profile.codeClusters as Array<{ teachingOrder: number; title: string }> | undefined) ?? [];
    const existingChapterTitles = clusters.map((c) => c.title);
    if (existingChapterTitles.length === 0) {
      const outline = await getActiveOutline(repository.id).catch(() => null);
      if (outline) {
        const allChapters = allChaptersInTeachingOrder(outline);
        existingChapterTitles.push(...allChapters.map((c) => c.title).filter(Boolean));
      } else {
        const navTreeNodes = (repository.navTree as Array<{ title?: string; path?: string }> | null) ?? [];
        existingChapterTitles.push(...navTreeNodes.filter((n) => n.title).map((n) => n.title as string));
      }
    }

    // ── Stage 1：LLM 计划（失败降级 conservativePlan）──
    const llmPlan = await generateUpdatePlan({
      owner,
      repo,
      branch: targetBranch,
      fromSha,
      toSha,
      candidateSet,
      existingChapterTitles,
      userId,
      token: githubToken,
    });
    const plan = llmPlan ?? conservativePlan(candidateSet, existingChapterTitles);

    // ── 审计快照落库（通过 Go worker-sidecar 单写者）──
    const run = await callSidecar<{ ok: boolean; id: string }>(
      '/v1/update/runs/create',
      {
        repositoryId: repository.id,
        userId,
        fromSha,
        toSha,
        status: 'PLANNED',
        plan,
        candidateSet,
        stats: {
          diff: candidateSet.diffStats,
          chapters: candidateSet.chapters.length,
          unmatched: candidateSet.unmatchedFiles.length,
        },
      },
      { label: 'update-runs-create' }
    );

    return ok({
      runId: run.id,
      plan,
      diffStats: candidateSet.diffStats,
      architectureDrift: candidateSet.architectureDrift,
      candidates: candidateSet.chapters.map((c) => ({
        path: c.path,
        title: c.title,
        change: c.change,
        affectedFiles: c.affectedFiles.length,
      })),
    });
  },
});
