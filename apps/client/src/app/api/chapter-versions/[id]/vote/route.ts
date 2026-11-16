import { defineRoute, ok } from '@/lib/api/server/define-route';
import { ApiError } from '@/lib/api/server/api-error';
import { checkRateLimit } from '@/lib/rate-limit';
import { callSidecar } from '@/lib/sidecar-client';

export const dynamic = 'force-dynamic';

interface SidecarChapterVersionVoteResponse {
  ok: boolean;
  notFound?: boolean;
  forbidden?: boolean;
  invalidState?: boolean;
  selfVote?: boolean;
  voted?: boolean;
  voteCount?: number;
  documentId?: string;
}

/**
 * POST /api/chapter-versions/[id]/vote —— 阅读时版本投票（toggle，一人一版一票）。
 * 挑战者票数达正典 + flipMargin 时服务端自动夺位翻正。
 * 下沉至 Go worker-sidecar 原生 SELECT FOR UPDATE 行锁事务执行，Node 保持零行级锁争抢。
 */
export const POST = defineRoute<{ id: string }>({
  scope: 'POST /api/chapter-versions/[id]/vote',
  auth: 'user',
  handler: async ({ params, userId }) => {
    // auth:'user' 已拦截未登录；此处收窄仅为类型细化（防御性，不可达）
    if (!userId) throw ApiError.unauthorized();
    if (!(await checkRateLimit(`version-vote:${userId}`, 30, 60_000))) {
      throw ApiError.tooManyRequests('操作过于频繁');
    }

    const { id } = params;
    const res = await callSidecar<SidecarChapterVersionVoteResponse>(
      '/v1/chapter-versions/vote',
      { versionId: id, userId },
      { label: 'chapter-versions-vote /v1/chapter-versions/vote', timeoutMs: 5_000 }
    );

    if (res.notFound) {
      throw ApiError.notFound('版本不存在', { code: 'NOT_FOUND' });
    }
    if (res.forbidden) {
      throw ApiError.forbidden('Forbidden', { code: 'FORBIDDEN' });
    }
    if (res.invalidState) {
      throw new ApiError(409, '私有版本不可投票', { code: 'INVALID_STATE' });
    }
    if (res.selfVote) {
      throw new ApiError(409, '不能为自己的版本投票', { code: 'SELF_VOTE' });
    }

    let canonicalChanged = false;
    if (res.documentId) {
      const { maybeFlipCanonical } = await import('@/lib/update-market/versions');
      const flip = await maybeFlipCanonical(res.documentId);
      canonicalChanged = flip.flipped;
    }

    return ok({
      voted: res.voted ?? false,
      voteCount: res.voteCount ?? 0,
      canonicalChanged,
    });
  },
});
