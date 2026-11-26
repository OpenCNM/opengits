import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';

export const POST = defineRoute<{ owner?: string; id?: string }>({
  scope: 'POST /api/repos/[owner]/view',
  auth: 'public',
  handler: async ({ params }) => {
    const repositoryId = params.owner || params.id;

    if (!repositoryId) {
      throw ApiError.badRequest('Repository ID is required');
    }

    try {
      await callSidecar(
        '/v1/repos/view',
        { repositoryId },
        { label: 'repos-view /v1/repos/view', timeoutMs: 3_000 }
      );
    } catch {
      return ok({});
    }

    return ok({});
  },
});
