import { z } from 'zod';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { arbitrateScopeVerdict } from '@/lib/scout/pipeline/scope-verdict';
import { executeSidecarScoutInspect } from '@/engine/scout-driver';
import { fetchRepoMeta } from '@/lib/scout/pipeline/repo-meta';

export const POST = defineRoute({
  scope: 'POST /api/scout/scope-verdict',
  auth: 'user',
  bodySchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    sha: z.string().optional(),
    branch: z.string().optional(),
    targetLanguage: z.string().optional(),
    customPrompt: z.string().optional(),
    forceRefresh: z.boolean().optional(),
  }),
  handler: async ({ body, userId }) => {
    if (!userId) throw ApiError.unauthorized();

    const { githubToken } = await fetchRepoMeta(body.owner, body.repo, userId).catch(() => ({ githubToken: undefined }));

    const inspectRes = await executeSidecarScoutInspect({
      owner: body.owner,
      repo: body.repo,
      branch: body.branch,
      sha: body.sha,
      token: githubToken,
    });

    const verdict = await arbitrateScopeVerdict({
      dirTree: inspectRes.dirTree,
      markdownFiles: inspectRes.markdownFiles,
      docCodeRatio: inspectRes.profile?.docCodeRatio,
      owner: body.owner,
      repo: body.repo,
      sha: body.sha,
      userId,
      targetLanguage: body.targetLanguage,
      customPrompt: body.customPrompt,
      readmeSnippet: inspectRes.readmeSnippet,
      forceRefresh: body.forceRefresh ?? true,
    });

    return ok({
      ok: true,
      verdict,
    });
  },
});
