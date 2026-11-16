import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { unpublishRepository } from '@/lib/review/unpublish-repository';
import { UnpublishRepositoryInputSchema } from '@/lib/schemas/credit-grant';

export const POST = defineRoute({
  scope: 'POST /api/repos/unpublish',
  auth: 'user',
  rateLimit: {
    limit: 10,
    windowMs: 3_600_000,
    identifier: ({ userId }) => `unpublish:${userId ?? 'anonymous'}`,
  },
  bodySchema: UnpublishRepositoryInputSchema,
  handler: async ({ body, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    const result = await unpublishRepository(userId, body);
    return ok(result);
  },
});
