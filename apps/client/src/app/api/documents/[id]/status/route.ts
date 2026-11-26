import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';
import { decodeStructuredDbError } from '@/lib/llm-gateway/upstream-error';

interface SidecarDocStatusResponse {
  ok: boolean;
  found: boolean;
  status: string;
  errorMessage: string | null;
  progress: number;
  step: string;
  progressInfo: { progress: number; step: string; updatedAt?: string } | null;
}

export const GET = defineRoute<{ id: string }>({
  scope: 'GET /api/documents/[id]/status',
  auth: 'public',
  handler: async ({ params, userId }) => {
    const { checkDocumentAccess } = await import('@/lib/auth-utils');
    const hasAccess = await checkDocumentAccess(params.id, userId || undefined);
    if (!hasAccess) {
      throw ApiError.forbidden('Insufficient permissions', { code: 'FORBIDDEN' });
    }

    let res: SidecarDocStatusResponse;
    try {
      res = await callSidecar<SidecarDocStatusResponse>(
        '/v1/documents/status',
        { documentId: params.id },
        { label: 'doc-status /v1/documents/status', timeoutMs: 3_000 }
      );
    } catch (err: unknown) {
      const msg = (err as Error)?.message || '';
      if (msg.includes('404') || msg.includes('not found')) {
        throw ApiError.notFound('Document not found', { code: 'DOCUMENT_NOT_FOUND' });
      }
      throw err;
    }

    if (!res.found) {
      throw ApiError.notFound('Document not found', { code: 'DOCUMENT_NOT_FOUND' });
    }

    const errorMeta = decodeStructuredDbError(res.errorMessage);
    const cleanErrorMessage = errorMeta
      ? errorMeta.upstreamMessage || errorMeta.code || res.errorMessage
      : res.errorMessage;

    return ok({
      status: res.status,
      errorMessage: cleanErrorMessage,
      ...(errorMeta ? { errorMeta } : {}),
      progress: res.progress,
      step: res.step,
      progressInfo: res.progressInfo,
    });
  },
});
