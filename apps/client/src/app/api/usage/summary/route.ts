import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';

interface UsageSummaryResponse {
  ok: boolean;
  summary?: {
    tier: string;
    isAdmin: boolean;
    reposUsed: number;
    maxRepos: number;
    mcpCallsToday: number;
    dailyMcpCalls: number;
    tokens30d: number;
  };
  error?: string;
  code?: string;
}

/**
 * GET /api/usage/summary —— 当前用户的配额与用量摘要（配额仪表盘数据源）。
 * 下沉至 Go worker-sidecar 原生聚合（POST /v1/usage/summary）。
 */
export const GET = defineRoute({
  scope: 'GET /api/usage/summary',
  auth: 'user',
  handler: async ({ userId }) => {
    if (!userId) throw ApiError.unauthorized();

    const res = await callSidecar<UsageSummaryResponse>(
      '/v1/usage/summary',
      { userId },
      { label: 'usage-summary /v1/usage/summary', timeoutMs: 5_000 }
    );

    if (!res.ok || !res.summary) {
      if (res.code === 'USER_NOT_FOUND') {
        throw ApiError.notFound('User not found', { code: 'USER_NOT_FOUND' });
      }
      throw ApiError.internal(res.error || 'Failed to get usage summary');
    }

    return ok(res.summary);
  },
});
