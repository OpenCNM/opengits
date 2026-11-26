import { TRANSCRIPTION_JIT_PRIORITY } from '@/lib/constants';
import { clientIpFromRequest } from '@/lib/rate-limit';
import { ENGINE_CONFIG } from '@/lib/config';
import { callSidecar } from '@/lib/sidecar-client';
import { defineRoute, ok } from '@/lib/api/server/define-route';

export const POST = defineRoute<{ id: string }>({
  scope: 'POST /api/documents/[id]/prioritize',
  auth: 'public',
  rateLimit: {
    limit: ENGINE_CONFIG.rateLimit.docPrioritizeMaxRequests,
    windowMs: ENGINE_CONFIG.rateLimit.docPrioritizeWindowMs,
    identifier: ({ request, userId }) => `doc-prioritize:${userId ?? clientIpFromRequest(request.headers)}`,
  },
  handler: async ({ params, userId }) => {
    const documentId = params.id;

    await callSidecar(
      '/v1/transcription/jobs/prioritize',
      {
        documentId,
        requestedBy: userId || 'anonymous',
        priority: TRANSCRIPTION_JIT_PRIORITY,
      },
      { label: 'transcription-prioritize' }
    );

    return ok({ prioritized: true, documentId });
  },
});
