import { defineRoute, ok } from '@/lib/api/server/define-route';
import { getRepositoryVersions } from '@/lib/repository-resolver';

/**
 * GET /api/versions/[owner]/[repo] —— 仓库的讲法（edition）行列表。
 */
export const GET = defineRoute<{ owner: string; repo: string }>({
  scope: 'GET /api/versions/[owner]/[repo]',
  auth: 'public',
  handler: async ({ params }) => {
    const { owner, repo } = params;
    const versions = await getRepositoryVersions(owner, repo);
    return ok({ versions });
  },
});
