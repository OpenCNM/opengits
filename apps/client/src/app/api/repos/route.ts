import { z } from 'zod';
import { prisma } from '@/lib/db';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { callSidecar } from '@/lib/sidecar-client';
import { deleteRepositoryForUser } from '@/lib/repo-delete-auth';

const saveActionSchema = z.object({
  action: z.enum(['save', 'unsave', 'follow']).default('save'),
  id: z.string().optional(),
  repositoryId: z.string().optional(),
  owner: z.string().optional(),
  repo: z.string().optional(),
  autoFollow: z.boolean().optional(),
  value: z.boolean().optional(),
});

export const POST = defineRoute({
  scope: 'POST /api/repos',
  auth: 'user',
  bodySchema: saveActionSchema,
  handler: async ({ body, userId }) => {
    if (!userId) throw ApiError.unauthorized();

    let id = body.id || body.repositoryId;
    const action = body.action;

    if (!id && body.owner && body.repo) {
      const found = await prisma.repository.findFirst({
        where: { owner: body.owner, repo: body.repo, isPublic: true },
        select: { id: true }
      });
      if (found) {
        id = found.id;
      }
    }

    if (!id) {
      throw ApiError.badRequest('Repository ID is required');
    }

    if (action === 'unsave') {
      await callSidecar(
        '/v1/repos/unsave',
        { userId, repositoryId: id },
        { label: 'repos-unsave' }
      );

      const targetRepo = await prisma.repository.findUnique({
        where: { id },
        select: { id: true, owner: true, repo: true },
      });
      if (targetRepo) {
        const { invalidateWebL1Projection } = await import('@/lib/docs/web-outline-projection');
        invalidateWebL1Projection(targetRepo.id);
        invalidateWebL1Projection(`${targetRepo.owner}/${targetRepo.repo}`);
        const { revalidatePath } = await import('next/cache');
        revalidatePath(`/docs/${targetRepo.owner}/${targetRepo.repo}`, 'layout');
      }

      return ok({ message: 'Repository removed from your shelf' });
    } else if (action === 'follow') {
      const updated = await callSidecar<{ ok: boolean; updated: boolean }>(
        '/v1/repos/follow',
        { userId, repositoryId: id, autoFollow: body.value !== false },
        { label: 'repos-follow' }
      );
      if (!updated?.updated) {
        throw ApiError.conflict('尚未收藏该教程');
      }
      return ok({ autoFollow: body.value !== false });
    } else {
      const targetRepo = await prisma.repository.findUnique({
        where: { id },
        select: { id: true, owner: true, repo: true, isPublic: true },
      });
      if (!targetRepo) {
        throw ApiError.notFound('Repository not found');
      }
      if (!targetRepo.isPublic) {
        const { isShelfFeeExempt } = await import('@/lib/credits/shelf-fee');
        const exempt = await isShelfFeeExempt(userId, id);
        if (!exempt) {
          throw new ApiError(403, '私有或已下架教程不可收藏', { code: 'FORBIDDEN' });
        }
      }

      const { chargeShelfFeeAndSave } = await import('@/lib/credits/shelf-fee');
      const charge = await chargeShelfFeeAndSave(userId, id, body.autoFollow ?? true);
      if (!charge.ok) {
        throw new ApiError(
          403,
          `积分不足：加入该教程需 ${charge.fee} 积分（当前余额 ${charge.balance}）。导入公开教程即可赚取积分。`,
          { code: 'INSUFFICIENT_BALANCE', detail: JSON.stringify({ fee: charge.fee, balance: charge.balance }) }
        );
      }

      const { invalidateWebL1Projection } = await import('@/lib/docs/web-outline-projection');
      invalidateWebL1Projection(targetRepo.id);
      invalidateWebL1Projection(`${targetRepo.owner}/${targetRepo.repo}`);
      const { revalidatePath } = await import('next/cache');
      revalidatePath(`/docs/${targetRepo.owner}/${targetRepo.repo}`, 'layout');

      return ok({
        message: 'Repository added to your shelf',
        fee: charge.fee,
        alreadySaved: charge.alreadySaved,
        signupGift: charge.signupGift,
        balance: 'balance' in charge ? charge.balance : undefined,
      });
    }
  },
});

export const DELETE = defineRoute({
  scope: 'DELETE /api/repos',
  auth: 'user',
  handler: async ({ request, userId }) => {
    if (!userId) throw ApiError.unauthorized();

    const { searchParams } = new URL(request.url);
    let id = searchParams.get('id') || searchParams.get('repositoryId');
    let owner = searchParams.get('owner');
    let repoName = searchParams.get('repo');
    let globalDelete = searchParams.get('global') === 'true' || searchParams.get('isGlobal') === 'true';

    if (!id && !owner && !repoName) {
      try {
        const body = await request.json();
        id = body.id || body.repositoryId;
        owner = body.owner;
        repoName = body.repo;
        if (body.global !== undefined) globalDelete = !!body.global;
        if (body.isGlobal !== undefined) globalDelete = !!body.isGlobal;
      } catch {
      }
    }

    const result = await deleteRepositoryForUser(userId, {
      id,
      owner,
      repo: repoName,
      globalDelete,
    });
    return ok({ message: result.message });
  },
});
