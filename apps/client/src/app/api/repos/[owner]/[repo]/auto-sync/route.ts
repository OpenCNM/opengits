import { z } from 'zod';
import { prisma } from '@/lib/db';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { checkRateLimit } from '@/lib/rate-limit';
import { resolveMaintainerUserId } from '@/lib/repository-maintainer';
import { callSidecar } from '@/lib/sidecar-client';

const autoSyncPatchSchema = z.object({ enabled: z.boolean() });

/**
 * 维护者自动同步开关：PATCH /api/repos/[owner]/[repo]/auto-sync
 *
 * 仅维护者（最早 ImportRecord 用户）可切换。开启 = 授权系统在检测到上游更新时
 * 以维护者的 BYOK 模型自动执行 plan→apply 维护共享正典（不删除章节）。
 */
export const PATCH = defineRoute<{ owner: string; repo: string }, { enabled: boolean }>({
  scope: 'PATCH /api/repos/[owner]/[repo]/auto-sync',
  auth: 'user',
  bodySchema: autoSyncPatchSchema,
  handler: async ({ body, params, userId }) => {
    // auth:'user' 已拦截未登录；此处收窄仅为类型细化（防御性，不可达）
    if (!userId) throw ApiError.unauthorized();
    if (!(await checkRateLimit(`auto-sync:${userId}`, 10, 60000))) {
      throw ApiError.tooManyRequests('操作过于频繁');
    }

    const { owner, repo } = params;
    const repository = await prisma.repository.findFirst({
      where: { owner, repo },
      select: { id: true },
    });
    if (!repository) {
      throw ApiError.notFound('Repository not found');
    }

    const maintainerId = await resolveMaintainerUserId(repository.id);
    if (maintainerId !== userId) {
      throw ApiError.forbidden('仅教程维护者可切换自动同步');
    }

    await callSidecar(
      '/v1/repos/patch',
      {
        id: repository.id,
        autoSyncEnabled: body.enabled,
      },
      { label: 'auto-sync-repo-patch' }
    );

    return ok({ autoSyncEnabled: body.enabled });
  },
});
