import { prisma } from '@/lib/db';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { verifyRepoAccessDirect } from '@/lib/auth-utils';
import { ENGINE_CONFIG } from '@/lib/config';
import { resolveRepository } from '@/lib/repository-resolver';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

/**
 * POST /api/update/[owner]/[repo]/check
 *
 * 主动"检查更新"：实时查询 GitHub 上游最新 commit，对比用户导入版本。
 * 纯查询零写库；有新版本时前端打开更新计划对话框（plan → apply 两阶段）。
 */
export const POST = defineRoute<{ owner: string; repo: string }>({
  scope: 'POST /api/update/[owner]/[repo]/check',
  auth: 'user',
  handler: async ({ request, params, userId }) => {
    try {
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

      // web 文档库分流：sitemap/ETag 差分探测（probeWebDocUpstream 顺带刷新检测时间与
      // lastmod 基线），不打 GitHub API——此前 web 库在这里必然 GitHub 404 → 500
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
      // ApiError（鉴权/404/403/409）原样透传；其余按「无法连接 GitHub」口径统一为 500
      if (err instanceof ApiError) throw err;
      throw ApiError.internal('检查更新失败，请稍后重试（无法连接 GitHub）');
    }
  },
});
