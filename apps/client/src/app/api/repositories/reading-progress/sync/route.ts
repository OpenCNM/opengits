import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';

interface ReadingProgressSyncSidecarResponse {
  ok: boolean;
  chapterScores?: Record<string, number>;
  overallProgress?: number;
  viewedCount?: number;
  lastReadPath?: string | null;
  lastReadAt?: string | null;
  error?: string;
}

export const GET = defineRoute({
  scope: 'GET /api/repositories/reading-progress/sync',
  auth: 'public',
  handler: async ({ request, userId }) => {
    if (!userId) {
      return ok({ chapterScores: {}, overallProgress: 0 });
    }

    const { searchParams } = new URL(request.url);
    const owner = searchParams.get('owner');
    const repo = searchParams.get('repo');
    const edition = searchParams.get('edition') ?? '';

    if (!owner || !repo) {
      throw ApiError.badRequest('Missing owner or repo');
    }

    const sidecarRes = await callSidecar<ReadingProgressSyncSidecarResponse>(
      '/v1/reading/progress-sync',
      {
        userId,
        owner,
        repo,
        edition: edition || undefined,
      },
      { label: 'reading /v1/reading/progress-sync' }
    );

    return ok({
      chapterScores: sidecarRes.chapterScores || {},
      overallProgress: sidecarRes.overallProgress || 0,
      viewedCount: sidecarRes.viewedCount || 0,
    });
  },
});
