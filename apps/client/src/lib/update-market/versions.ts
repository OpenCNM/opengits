// 章节多版本竞争引擎（接力 v2）。
//
// 语义：RELAY 首译与重译产出并列 ChapterVersion；读者阅读时投票（一人一版一票，toggle）；
// 正典仲裁顺序：维护者钦定（pinnedAt 非空，投票不可翻转）> 社区投票夺位
// （挑战者票数 ≥ 正典 + flipMargin，在位者偏置）> 初始首译。
// 重译/夺位积分奖励已退役：不发钱包积分、不加身价；历史奖励记录保留。
// 图谱/检索只挂正典；翻正后复用 postSwap 重索引链。
// 物理单写者：所有 ChapterVersion 写操作（创建、公开、删除、置顶、翻正、GC）已全面下沉至 Go worker-sidecar。

import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { commitCanonicalPromotion } from '@/lib/update-market/canonical-convergence';
import {
  executeSidecarChapterVersionCreate,
  executeSidecarChapterVersionPublish,
  executeSidecarChapterVersionDelete,
  executeSidecarChapterVersionPin,
} from '@/engine/market-driver';

const MARKET = ENGINE_CONFIG.updateMarket;

export class VersionMarketError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_STATE' | 'SELF_VOTE'
  ) {
    super(message);
  }
}

/** 契约重译：产出 PRIVATE 版本（仅作者可见）+ RETRANSLATE 记账行（baseCredits=0） */
export async function retranslateChapter(documentId: string, userId: string): Promise<{ versionId: string }> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      path: true,
      repositoryId: true,
      repository: { select: { gitSha: true, repoProfile: true } },
    },
  });
  if (!doc?.repository?.gitSha) {
    throw new VersionMarketError('章节不存在或无版本基线', 'NOT_FOUND');
  }

  // 2026-10 下沉：接力生成走 Go staged-relay（契约三件套闭环于 Go，
  // 与市场 RELAY 分支同源——重译与首译口径归一）
  const { generateRelayStagedContent } = await import('./jobs');
  const { mdx, model } = await generateRelayStagedContent(documentId, {
    userId,
    sourceSha: doc.repository.gitSha,
  });

  const { upsertContentLayer, computeContentHash, computeRequestFingerprint } = await import('@/lib/content-addressing');
  const { fingerprintInputsFor } = await import('@/lib/transcription/fingerprint');
  const { toProfileRecord } = await import('@/lib/transcription/types');
  // 指纹与 Go prepare 同解析链（缺省由 repoProfile 兜底 + preset 默认展开）：
  // 重译成品因此可被后续 prepare 的 FindReusableContentByFingerprint 命中复用。
  const fingerprint = computeRequestFingerprint(
    fingerprintInputsFor(
      {
        repositoryId: doc.repositoryId,
        path: doc.path,
        repository: { gitSha: doc.repository.gitSha, repoProfile: toProfileRecord(doc.repository.repoProfile) },
      },
      model,
      {},
    ),
  );
  const contentId = await upsertContentLayer({
    contentHash: computeContentHash(mdx, ''),
    requestFingerprint: fingerprint,
    content: mdx,
    lang: '',
    generationModel: model,
  });

  const { versionId } = await executeSidecarChapterVersionCreate({
    documentId,
    repositoryId: doc.repositoryId,
    authorId: userId,
    contentId,
    source: 'RETRANSLATE',
    visibility: 'PRIVATE',
  });

  // 保留重译任务记录（SWAPPED 终态，不进活跃列表）；公开/夺位不再回填奖励。
  const { executeSidecarMarketJobRetranslateRecord } = await import('@/engine/market-driver');
  await executeSidecarMarketJobRetranslateRecord({
    repositoryId: doc.repositoryId,
    documentId,
    path: doc.path,
    gitSha: doc.repository.gitSha,
    userId,
    contentId,
    stagedModel: model,
  }).catch((err) => {
    console.warn('[versions] create retranslate job record failed via sidecar:', err);
  });

  return { versionId };
}

/** 私有版本公开：进入竞争池（重译发酬已退役，不发积分） */
export async function publishChapterVersion(versionId: string, userId: string): Promise<{ base: number }> {
  const res = await executeSidecarChapterVersionPublish({ versionId, userId });
  if (res.notFound || res.forbidden) {
    throw new VersionMarketError('版本不存在', 'NOT_FOUND');
  }

  return { base: 0 };
}

/** 作者删除自己的私有版本（公开版本由 GC 与竞争淘汰治理） */
export async function deletePrivateVersion(versionId: string, userId: string): Promise<void> {
  const res = await executeSidecarChapterVersionDelete({ versionId, userId });
  if (res.notFound || res.forbidden) {
    throw new VersionMarketError('版本不存在', 'NOT_FOUND');
  }
  if (res.invalidState) {
    throw new VersionMarketError('已公开的版本由社区投票治理，不可删除', 'INVALID_STATE');
  }
}

/**
 * 阅读时投票（toggle）：下沉至 Go worker-sidecar 原生 SELECT FOR UPDATE 行锁事务执行。
 * 杜绝并发竞争与脏写，Node 侧零 Prisma 写库（单写者收敛至 Go）。
 */
export async function toggleChapterVersionVote(
  versionId: string,
  userId: string
): Promise<{ voted: boolean; voteCount: number; canonicalChanged: boolean }> {
  const { callSidecar } = await import('@/lib/sidecar-client');
  const res = await callSidecar<{
    ok: boolean;
    notFound?: boolean;
    forbidden?: boolean;
    invalidState?: boolean;
    selfVote?: boolean;
    voted?: boolean;
    voteCount?: number;
    documentId?: string;
  }>(
    '/v1/chapter-versions/vote',
    { versionId, userId },
    { label: 'chapter-versions-vote /v1/chapter-versions/vote', timeoutMs: 5_000 }
  );

  if (res.notFound) throw new VersionMarketError('版本不存在', 'NOT_FOUND');
  if (res.forbidden) throw new VersionMarketError('无权限操作该版本', 'FORBIDDEN');
  if (res.invalidState) throw new VersionMarketError('私有版本不可投票', 'INVALID_STATE');
  if (res.selfVote) throw new VersionMarketError('不能为自己的版本投票', 'SELF_VOTE');

  let canonicalChanged = false;
  if (res.documentId) {
    const flip = await maybeFlipCanonical(res.documentId);
    canonicalChanged = flip.flipped;
  }

  return {
    voted: res.voted ?? false,
    voteCount: res.voteCount ?? 0,
    canonicalChanged,
  };
}

/**
 * 夺位翻正（投票后调用）：最高票挑战者 voteCount ≥ 正典 + flipMargin 才翻，
 * 平票/接近维持现状（在位者偏置）。维护者钦定正典（pinnedAt 非空）对夺位免疫——
 * 作者裁决优先于社区投票。翻正事务：指针翻转 + isCanonical 互换 +
 * 双方向通知；事后重索引，不读写奖励台账。
 */
export async function maybeFlipCanonical(
  documentId: string
): Promise<{ flipped: boolean; canonicalVersionId?: string }> {
  const res = await commitCanonicalPromotion({ documentId });
  return { flipped: res.flipped, canonicalVersionId: res.canonicalVersionId };
}

/**
 * 教程维护者/管理员将指定版本一键设为推荐正典（Pin as Canonical，作者最高裁决权）
 */
export async function pinChapterVersion(
  versionId: string,
  userId: string
): Promise<{ success: boolean }> {
  const { isAdminRole } = await import('@/lib/tier-limits');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  const isAdmin = isAdminRole(user?.role);

  const res = await executeSidecarChapterVersionPin({
    versionId,
    userId,
    isAdmin,
  });

  if (!res.found) {
    throw new VersionMarketError('版本不存在', 'NOT_FOUND');
  }
  if (res.forbidden) {
    throw new VersionMarketError('仅教程维护者可设为推荐正典', 'FORBIDDEN');
  }

  if (res.flipped) {
    if (res.postSwapPayload?.content) {
      const payload = res.postSwapPayload;
      const { postSwap } = await import('@/lib/update-market/jobs');
      void postSwap(
        {
          repositoryId: payload.repositoryId,
          documentId: payload.documentId,
          path: payload.path,
          stagedContentId: payload.contentId,
        },
        payload.content
      ).catch((e) => {
        void import('@/lib/observability/errors').then((m) =>
          m.captureError(e, { scope: 'version-market/pin-reindex', extra: { documentId: res.documentId } })
        );
      });
    }
  }

  return { success: res.success };
}
