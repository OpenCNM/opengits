import { z } from 'zod';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { checkRepoDuplicates } from '@/lib/repo-dedup';

const checkDedupSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  edition: z.string().optional().default(''),
});

/**
 * 仓库毫秒级前置查重端点：供导入向导在启动重度探测管线前快速短路已有仓库，
 * 避免重复仓库误入图1的 3 步探测分析等待流程。
 */
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

