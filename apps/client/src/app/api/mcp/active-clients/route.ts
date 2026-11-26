import { defineRoute, ok } from '@/lib/api/server/define-route';
import { projectActiveClients } from '@/lib/mcp/active-clients-projection';

export const GET = defineRoute({
  scope: 'GET /api/mcp/active-clients',
  auth: 'public',
  handler: async ({ userId }) => {
    if (!userId) {
      return ok({ clients: [] });
    }

    const clients = await projectActiveClients(userId);
    return ok({ clients });
  },
});
