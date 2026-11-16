import { TRANSCRIPTION_JIT_PRIORITY } from '@/lib/constants';
import { clientIpFromRequest } from '@/lib/rate-limit';
import { ENGINE_CONFIG } from '@/lib/config';
import { callSidecar } from '@/lib/sidecar-client';
import { defineRoute, ok } from '@/lib/api/server/define-route';

/**
 * POST /api/documents/[id]/prioritize —— 提升文档转录优先级至 JIT 高权，即时抢占消费。
 * 优先级为服务端权威常量（TRANSCRIPTION_JIT_PRIORITY），不接受客户端传值；
 * 登录按 userId、匿名按 IP 限流——每次插队等价于 1 个 LLM 任务的算力支出。
 */
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
