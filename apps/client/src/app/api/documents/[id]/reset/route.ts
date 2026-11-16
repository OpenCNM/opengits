import { z } from 'zod';
import { callSidecar } from '@/lib/sidecar-client';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';

const ResetBodySchema = z.object({
  force: z.boolean().optional(),
});

/**
 * POST /api/documents/[id]/reset —— 手工重置文档到 UNPROCESSED。
 *
 * CAS 守卫：默认仅当文档非 PROCESSING 时才允许重置，避免与在途转录竞态
 * （否则可能 null 掉刚 finalize 的 content，重现"PROCESSED 但空内容"历史 bug）。
 * force=true 时绕过守卫：用于解锁崩溃残留的 PROCESSING 文档（进程中断后无
 * 自动回收，reset 被 409 拒绝会导致文档永久砖化，只能直连数据库改状态）。
 */
export const POST = defineRoute<{ id: string }, z.infer<typeof ResetBodySchema>>({
  scope: 'POST /api/documents/[id]/reset',
  auth: 'public',
  bodySchema: ResetBodySchema,
  handler: async ({ params, body, userId }) => {
    const { checkDocumentAccess } = await import('@/lib/auth-utils');
    const hasAccess = await checkDocumentAccess(params.id, userId ?? undefined);
    if (!hasAccess) {
      throw ApiError.forbidden('Insufficient permissions', { code: 'FORBIDDEN' });
    }

    try {
      const res = await callSidecar<{ ok: boolean; document: { id: string; status: string; path: string } }>(
        '/v1/documents/reset',
        { documentId: params.id, force: body.force ?? false },
        { label: 'reset document' }
      );
      return ok({ document: res.document });
    } catch (err: any) {
      if (err.status === 409 || err.message?.includes('processing')) {
        throw ApiError.conflict('文档正在处理中（PROCESSING），无法重置。请稍后再试。', {
          code: 'PROCESSING',
        });
      }
      throw err;
    }
  },
});
