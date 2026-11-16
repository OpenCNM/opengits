import { defineRoute, ok } from '@/lib/api/server/define-route';
import { projectActiveClients } from '@/lib/mcp/active-clients-projection';

export const GET = defineRoute({
  scope: 'GET /api/mcp/active-clients',
  auth: 'public',
  handler: async ({ userId }) => {
    if (!userId) {
      return ok({ clients: [] });
    }

    // SSE 流不可用时的回落端点：与流共用同一读侧投影（按客户端统计 + 双阈值在线态）
    const clients = await projectActiveClients(userId);
    return ok({ clients });
  },
});
