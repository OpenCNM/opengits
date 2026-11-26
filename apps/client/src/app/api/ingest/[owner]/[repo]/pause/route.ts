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

export const POST = defineRoute<{ owner: string; repo: string }, z.infer<typeof PauseBodySchema>>({
  scope: 'POST /api/ingest/[owner]/[repo]/pause',
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
