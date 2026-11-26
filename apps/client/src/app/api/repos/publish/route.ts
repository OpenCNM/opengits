import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { publishRepository } from '@/lib/review/publish-repository';
import { z } from 'zod';

const bodySchema = z.object({
  repoId: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  edition: z.string().optional(),
  relayEnabled: z.boolean().optional(),
  onlyToggleRelay: z.boolean().optional(),
  withdraw: z.boolean().optional(),
}).refine((body) => body.repoId || (body.owner && body.repo));

export const PATCH = defineRoute({
  scope: 'PATCH /api/repos/publish', auth: 'user',
  rateLimit: { limit: 10, windowMs: 3_600_000, identifier: ({ userId }) => `publish:${userId ?? 'anonymous'}` },
  bodySchema,
  handler: async ({ body, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    return ok(await publishRepository(userId, { ...body, repoName: body.repo }));
  },
});
