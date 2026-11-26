import { z } from 'zod';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { checkRepoDuplicates } from '@/lib/repo-dedup';

const checkDedupSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  edition: z.string().optional().default(''),
});

export const POST = defineRoute({
  scope: 'POST /api/repos/check-dedup',
  auth: 'public',
  rateLimit: {
    limit: 60,
    windowMs: 60_000,
  },
  bodySchema: checkDedupSchema,
  handler: async ({ body, userId }) => {
    const dedupInfo = await checkRepoDuplicates({
      owner: body.owner,
      repo: body.repo,
      userId: userId ?? undefined,
      edition: body.edition,
    });

    return ok({ dedupInfo });
  },
});
