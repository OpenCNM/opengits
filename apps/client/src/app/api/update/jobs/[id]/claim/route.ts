import { prisma } from '@/lib/db';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/update/jobs/[id]/claim —— 主动放弃已认领的章节任务。
 * 立即释放租约锁，将任务原子回池为 PENDING，允许社区其他读者立刻接力。
 * id 兼容 ChapterUpdateJob.id 与 documentId 两种口径（胶囊/工作台持 documentId，
 * 与 claim-transcribe 的解析模式对齐：documentId → 该文档当前 CLAIMED 任务）。
 */
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

    // documentId 口径：解析该文档当前被认领的任务（无 CLAIMED 任务则交由
    // abandonClaim 的 NOT_FOUND/INVALID_STATE 语义兜底）
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
