import { prisma } from '@/lib/db';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';

export const dynamic = 'force-dynamic';

export const DELETE = defineRoute<{ id: string }>({
  scope: 'DELETE /api/update/jobs/[id]/claim',
  auth: 'user',
  rateLimit: {
    limit: 20,
    windowMs: 60_000,
    identifier: ({ userId }) => `claim-abandon:${userId}`,
  },
  handler: async ({ params, userId }) => {
    if (!userId) throw ApiError.unauthorized();
    let { id } = params;

    if (await prisma.document.findUnique({ where: { id }, select: { id: true } })) {
      const claimedJob = await prisma.chapterUpdateJob.findFirst({
        where: { documentId: id, status: 'CLAIMED' },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (claimedJob) id = claimedJob.id;
    }

    const { abandonClaim, UpdateMarketError } = await import('@/lib/update-market/jobs');
    try {
      await abandonClaim(id, userId);
      return ok(true);
    } catch (err) {
      if (err instanceof UpdateMarketError) {
        if (err.code === 'NOT_FOUND') throw ApiError.notFound('任务不存在');
        throw ApiError.badRequest(err.message);
      }
      throw err;
    }
  },
});
