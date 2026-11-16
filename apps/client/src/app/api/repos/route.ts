import { revalidateTag } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { maybePruneRepoAssetDir } from '@/lib/storage/assets-gc';
import { PUBLIC_HOME_CACHE_TAG } from '@/lib/home/public-home-data';
import { notifyClientRevalidate } from '@/lib/review/publish-fanout';
import { callSidecar } from '@/lib/sidecar-client';

const saveActionSchema = z.object({
  action: z.enum(['save', 'unsave', 'follow']).default('save'),
  id: z.string().optional(),
  repositoryId: z.string().optional(),
  owner: z.string().optional(),
  repo: z.string().optional(),
  /** save：跟随公共副本自动同步（默认 true）；follow：目标值 */
  autoFollow: z.boolean().optional(),
  value: z.boolean().optional(),
});

export const POST = defineRoute({
  scope: 'POST /api/repos',
  auth: 'user',
  bodySchema: saveActionSchema,
  handler: async ({ body, userId }) => {
    // auth:'user' 已拦截未登录；此处收窄仅为类型细化（防御性，不可达）
    if (!userId) throw ApiError.unauthorized();

    let id = body.id || body.repositoryId;
    const action = body.action; // 'save' | 'unsave' | 'follow'

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
      // 跟随开关（书架已收藏前提下切换）：跟随 = 内容随维护同步 + 接收更新通知
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
      // 教程可见性与权限门禁：私有/下架教程仅豁免者（导入者/贡献者）可收藏；公开教程任何人可收藏
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

      // 书架收费（按教程劳动账本定价）：私有仓/豁免者（导入者/贡献者）免费，
      // 其余公开教程按「转录劳动总账 × admin 系数」从永久余额扣费（幂等不双扣）。
      // 余额不足 → 403 引导转录赚取（阅读本身不受影响，只卡个人收藏）。
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
    // auth:'user' 已拦截未登录；此处收窄仅为类型细化（防御性，不可达）
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
        // body might be empty
      }
    }

    if (!id && (!owner || !repoName)) {
      throw ApiError.badRequest('Repository ID or owner/repo is required');
    }

    // Fetch repository by id or owner/repo
    const repo = id
      ? await prisma.repository.findUnique({ where: { id }, select: { id: true, isPublic: true, owner: true, repo: true } })
      : await prisma.repository.findFirst({ where: { owner: owner!, repo: repoName! }, select: { id: true, isPublic: true, owner: true, repo: true } });

    if (!repo) {
      throw ApiError.notFound('Repository not found');
    }

    if (!repo.isPublic || globalDelete) {
      // 全局删除授权（审计矩阵 BUG-GEN-01 + 红队 GAP-1）：
      // - 管理员/ENTERPRISE：全量放行（平台治理动作）
      // - 私有仓属主：可删自己的仓（ownerUserId 归属证明）
      // - 公开仓：非特权一律仅能移出个人书架（公开内容是社区资产，防单人删除）
      const actor = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true, tier: true },
      });
      const { isAdminRole } = await import('@/lib/tier-limits');
      const isPrivileged = Boolean(actor && (isAdminRole(actor.role) || actor.tier === 'ENTERPRISE'));
      const { canGloballyDeleteRepo, userOwnsPrivateDocs } = await import('@/lib/repo-delete-auth');
      const ownsPrivateDocs = isPrivileged ? true : await userOwnsPrivateDocs(repo.id, userId);
      if (!canGloballyDeleteRepo({ actor, isPrivileged, repoIsPublic: repo.isPublic, ownsPrivateDocs, globalDelete })) {
        throw ApiError.forbidden('无权删除该仓库：公开仓删除需管理员；私有仓仅属主或管理员可删除');
      }

      // Delete the repository globally (DB cascades delete documents & conversations)
      await callSidecar(
        '/v1/repos/delete',
        { id: repo.id },
        { label: 'repos-global-delete' }
      );

      // 资产目录引用回收：DB 已无该仓行时清掉 storage/assets/{owner}/{repo}/（fire-and-forget）
      maybePruneRepoAssetDir(repo.owner, repo.repo);

      // 全局删除后统一失效首页与关联大纲缓存（消除多讲法兄弟聚合脏数据）
      revalidateTag(PUBLIC_HOME_CACHE_TAG, 'max');
      await notifyClientRevalidate([PUBLIC_HOME_CACHE_TAG], [repo.id]);

      return ok({ message: 'Repository deleted globally from database' });
    } else {
      // Personal shelf: disconnect from user's saved shelf
      await callSidecar(
        '/v1/repos/unsave',
        { userId, repositoryId: repo.id },
        { label: 'repos-unsave' }
      );

      return ok({ message: 'Repository removed from your shelf' });
    }
  },
});
