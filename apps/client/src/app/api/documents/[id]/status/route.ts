import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';

interface SidecarDocStatusResponse {
  ok: boolean;
  found: boolean;
  status: string;
  errorMessage: string | null;
  progress: number;
  step: string;
  progressInfo: { progress: number; step: string; updatedAt?: string } | null;
}

/**
 * GET /api/documents/[id]/status —— 文档转录状态 + 实时进度（重生成横幅与单章实时流活性轮询源）。
 * 下沉至 Go worker-sidecar 原生 pgx 执行，高频轮询零 Node Event Loop / Prisma 压力。
 * 权限模式：public（由 checkDocumentAccess 依仓库公开性与个人副本权属判定，支持公开仓读者与认证作者免阻断轮询）。
 */
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

    return ok({
      status: res.status,
      errorMessage: res.errorMessage,
      progress: res.progress,
      step: res.step,
      progressInfo: res.progressInfo,
    });
  },
});
