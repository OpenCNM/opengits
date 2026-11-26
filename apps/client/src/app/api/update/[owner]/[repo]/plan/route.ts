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
import { ignoreBestEffort } from '@/lib/best-effort';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

export const POST = defineRoute<{ owner: string; repo: string }>({
  scope: 'POST /api/update/[owner]/[repo]/plan',
  auth: 'user',
  handler: async ({ request, params, userId }) => {
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
    } catch {
      ignoreBestEffort();
    }

    const requestedBranch = queryBranch || bodyBranch || undefined;
    const requestedEdition = queryEdition !== null ? queryEdition : (bodyEdition !== undefined ? bodyEdition : undefined);

    const { resolveRepository } = await import('@/lib/repository-resolver');
    const resolved = await resolveRepository(owner, repo, requestedBranch, requestedEdition);
    if (!resolved || !resolved.repository) {
      throw ApiError.notFound('Repository not found');
    }
    if (requestedEdition && resolved.editionMiss) {
      throw new ApiError(404, '请求的讲法不存在或已下线', { code: 'EDITION_NOT_FOUND' });
    }
    const repository = resolved.repository;
    const targetBranch = resolved.resolvedBranch || repository.branch || ENGINE_CONFIG.defaultBranch;

    const isAuthorized = await verifyRepoAccessDirect(repository, userId);
    if (!isAuthorized) {
      throw ApiError.forbidden('Forbidden: You do not have access to this repository');
    }

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

    const { resolveLatestSha, fetchCompareDiff } = await import('@/engine/repo-tarball');
    const toSha = await resolveLatestSha(owner, repo, targetBranch);
    if (fromSha === toSha) {
      throw ApiError.conflict('教程已是最新版本', { code: 'NO_UPDATE', detail: toSha });
    }

    const { resolveGithubToken } = await import('@/lib/github/token-resolver');
    const githubToken = await resolveGithubToken(userId);
    const compareDiff = await fetchCompareDiff(owner, repo, fromSha, toSha, githubToken);

    const privateDoc = await prisma.document.findFirst({
      where: { repositoryId: repository.id, ownerUserId: userId },
      select: { id: true },
    });
    const docOwnerId = privateDoc ? userId : null;

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

    if (candidateSet.chapters.length === 0 && candidateSet.unmatchedFiles.length === 0) {
      return ok({
        noChanges: true,
        diffStats: candidateSet.diffStats,
        message: '上游有更新，但未涉及教程转录内容',
      });
    }

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
