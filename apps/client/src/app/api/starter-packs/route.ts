import { defineRoute, ok } from '@/lib/api/server/define-route';
import { getSessionHelper } from '@/lib/auth-helper';
import { listFreeStarterPacks } from '@/lib/starter-packs/starter-packs';

export const dynamic = 'force-dynamic';

export const GET = defineRoute({
  scope: 'GET /api/starter-packs',
  auth: 'public',
  handler: async () => {
    const session = await getSessionHelper();
    const userId = session?.user?.id || null;
    const result = await listFreeStarterPacks(userId);
    return ok(result);
  },
});
