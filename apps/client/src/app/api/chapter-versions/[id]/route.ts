import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';

export const dynamic = 'force-dynamic';

export const PATCH = defineRoute<{ id: string }>({
  scope: 'PATCH /api/chapter-versions/[id]',
  auth: 'user',
  rateLimit: {
    limit: 10,
    windowMs: 60_000,
    identifier: ({ userId }) => `version-publish:${userId}`,
  },
  handler: async ({ params, userId }) => {
    const { id } = params;
    const { publishChapterVersion, VersionMarketError } = await import('@/lib/update-market/versions');
    try {
      const { base } = await publishChapterVersion(id, userId);
      return ok({ baseGranted: base });
    } catch (err) {
      if (err instanceof VersionMarketError) {
        throw ApiError.fromCode(err.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'FORBIDDEN', { detail: err.message });
      }
      throw err;
    }
  },
});

export const DELETE = defineRoute<{ id: string }>({
  scope: 'DELETE /api/chapter-versions/[id]',
  auth: 'user',
  handler: async ({ params, userId }) => {
    const { id } = params;
    const { deletePrivateVersion, VersionMarketError } = await import('@/lib/update-market/versions');
    try {
      await deletePrivateVersion(id, userId);
      return ok({});
    } catch (err) {
      if (err instanceof VersionMarketError) {
        throw ApiError.fromCode(err.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'FORBIDDEN', { detail: err.message });
      }
      throw err;
    }
  },
});
