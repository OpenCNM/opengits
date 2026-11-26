import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { promoteEditionRepository } from '@/lib/review/promote-edition';
import { PromoteEditionInputSchema } from '@/lib/schemas/credit-grant';

export const POST = defineRoute({
  scope: 'POST /api/repos/promote-edition',
  auth: 'user',
  rateLimit: {
    limit: 10,
    windowMs: 3_600_000,
    identifier: ({ userId }) => `promote-edition:${userId ?? 'anonymous'}`,
  },
  bodySchema: PromoteEditionInputSchema,
  handler: async ({ body, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    const result = await promoteEditionRepository(userId, body);
    return ok(result);
  },
});
