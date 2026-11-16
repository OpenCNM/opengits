import { z } from 'zod';
import { prisma } from '@/lib/db';
import { checkRateLimit } from '@/lib/rate-limit';
import { REPORT_REASONS } from '@/lib/review/config';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';

/**
 * 内容举报（后置治理兜底）：登录用户对公开教程提交举报，进 admin 审核台队列。
 * 同一用户对同一仓库仅保留一条未处理举报（防重复刷）。
 */

const reportSchema = z.object({
  repositoryId: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  reason: z.enum(REPORT_REASONS),
  detail: z.string().trim().max(300).optional(),
});

export const POST = defineRoute({
  scope: 'POST /api/reports',
  auth: 'user',
  bodySchema: reportSchema,
  handler: async ({ body, userId }) => {
    if (!userId) throw ApiError.unauthorized();

    if (!(await checkRateLimit(`report:${userId}`, 3, 60000))) {
      throw ApiError.tooManyRequests('举报过于频繁，请稍后再试', { code: 'RATE_LIMITED' });
    }

    const { repositoryId, owner, repo, reason, detail } = body;

    const repository = repositoryId
      ? await prisma.repository.findUnique({ where: { id: repositoryId }, select: { id: true, isPublic: true } })
      : await prisma.repository.findFirst({
          where: { owner, repo },
          select: { id: true, isPublic: true },
        });
    if (!repository) {
      throw ApiError.notFound('Repository not found');
    }
    if (!repository.isPublic) {
      throw ApiError.badRequest('仅公开教程支持举报');
    }

    // 幂等：同人对同仓的未处理举报不重复创建
    const existing = await prisma.contentReport.findFirst({
      where: { repositoryId: repository.id, reporterId: userId, handledAt: null },
      select: { id: true },
    });
    if (existing) {
      return ok({ alreadyReported: true, message: '你已举报过该教程，管理员处理中。' });
    }

    await prisma.contentReport.create({
      data: { repositoryId: repository.id, reporterId: userId, reason, detail: detail || null },
    });

    return ok({ message: '举报已提交，管理员将尽快处理。' });
  },
});
