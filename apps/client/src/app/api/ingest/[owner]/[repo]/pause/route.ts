import { z } from 'zod';
import { ENGINE_CONFIG } from '@/lib/config';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';

const PauseBodySchema = z.object({
  paused: z.boolean(),
});

interface SidecarPauseResponse {
  ok: boolean;
  notFound?: boolean;
  forbidden?: boolean;
  paused?: boolean;
}

/**
 * 服务端转录暂停/恢复（跨浏览器会话持久）。
 * 客户端队列共同遵守 repository.transcriptionPaused；
 * 用户点暂停 / 开启"关闭页面自动暂停"（beacon 卸载钩子）均落库于此。
 * 下沉至 Go worker-sidecar 原生 pgx 原子判定权限与更新，Node 保持零 Prisma 依赖。
 */
export const POST = defineRoute<{ owner: string; repo: string }, z.infer<typeof PauseBodySchema>>({
  scope: 'POST /api/ingest/[owner]/[repo]/pause',
  // 匿名请求由 Go 端权限检查统一拒绝（403），语义与原实现一致
  auth: 'public',
  bodySchema: PauseBodySchema,
  handler: async ({ params, body, userId, request }) => {
    const { owner, repo } = params;
    const { editionParamFromUrl, resolveRepository } = await import('@/lib/repository-resolver');
    const edition = editionParamFromUrl(request);

    let explicitBranch: string | undefined;
    try {
      const url = new URL(request.url);
      explicitBranch = url.searchParams.get('branch')?.trim() || undefined;
    } catch {}

    const resolved = await resolveRepository(owner, repo, explicitBranch, edition);
    const branch = explicitBranch || resolved?.resolvedBranch || ENGINE_CONFIG.defaultBranch;
    const effectiveEdition = resolved ? resolved.resolvedEdition : (edition || undefined);

    const res = await callSidecar<SidecarPauseResponse>(
      '/v1/repos/pause',
      {
        owner,
        repo,
        branch,
        edition: effectiveEdition,
        userId: userId ?? undefined,
        paused: body.paused,
      },
      { label: 'repos-pause /v1/repos/pause', timeoutMs: 5_000 }
    );

    if (res.notFound) {
      throw ApiError.notFound('Repository not found', { code: 'REPOSITORY_NOT_FOUND' });
    }
    if (res.forbidden) {
      throw ApiError.forbidden('You do not have access to this repository', { code: 'FORBIDDEN' });
    }

    return ok({ paused: res.paused ?? body.paused });
  },
});
