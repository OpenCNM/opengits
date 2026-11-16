import { z } from 'zod';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';

const pinSchema = z.object({
  repositoryId: z.string().min(1),
  isPinned: z.boolean().optional(),
});

interface SidecarPinResponse {
  ok: boolean;
  pinnedRepoIds: string[];
}

export const POST = defineRoute({
  scope: 'POST /api/repositories/pin',
  auth: 'user',
  bodySchema: pinSchema,
  handler: async ({ body, userId }) => {
    // auth:'user' 已拦截未登录；此处收窄仅为类型细化（防御性，不可达）
    if (!userId) throw ApiError.unauthorized();
    const { repositoryId, isPinned } = body;

    const res = await callSidecar<SidecarPinResponse>(
      '/v1/user/pin',
      { userId, repositoryId, isPinned },
      { label: 'user-pin /v1/user/pin', timeoutMs: 5_000 }
    );

    return ok({
      pinnedRepoIds: res.pinnedRepoIds,
    });
  },
});
