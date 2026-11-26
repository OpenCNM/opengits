import { z } from 'zod';
import { callSidecar } from '@/lib/sidecar-client';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';

const ResetBodySchema = z.object({
  force: z.boolean().optional(),
});

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
