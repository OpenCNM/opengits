import { prisma } from '@/lib/db';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { ENGINE_CONFIG } from '@/lib/config';
import { resolveRepository } from '@/lib/repository-resolver';
import { ignoreBestEffort } from '@/lib/best-effort';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export const POST = defineRoute<{ owner: string; repo: string }>({
  scope: 'POST /api/update/[owner]/[repo]/check',
  auth: 'user',
  handler: async ({ request, params, userId }) => {
    try {
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

      const repoProfile = (repository.repoProfile as Record<string, unknown>) || {};
      if (repoProfile.sourceType === 'web' && repoProfile.originalUrl) {
        const { probeWebDocUpstream } = await import('@/lib/jobs/web-doc-job');
        const hasUpdate = await probeWebDocUpstream(repository);
        return ok({ hasUpdate });
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

      const importedSha = record?.sha || repository.gitSha;
      if (!importedSha) {
        throw ApiError.conflict('未找到导入记录，请先导入该仓库', { code: 'NO_IMPORT' });
      }

      const { resolveLatestSha } = await import('@/engine/repo-tarball');
      const currentSha = await resolveLatestSha(owner, repo, targetBranch);

      return ok({
        hasUpdate: importedSha !== currentSha,
        importedSha,
        currentSha,
        branch: targetBranch,
        edition: repository.edition,
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw ApiError.internal('检查更新失败，请稍后重试（无法连接 GitHub）');
    }
  },
});
