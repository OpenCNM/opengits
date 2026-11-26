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

  const { generateRelayStagedContent } = await import('./jobs');
  const { mdx, model } = await generateRelayStagedContent(documentId, {
    userId,
    sourceSha: doc.repository.gitSha,
  });

  const { upsertContentLayer, computeContentHash, computeRequestFingerprint } = await import('@/lib/content-addressing');
  const { fingerprintInputsFor } = await import('@/lib/transcription/fingerprint');
  const { toProfileRecord } = await import('@/lib/transcription/types');
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

export async function publishChapterVersion(versionId: string, userId: string): Promise<{ base: number }> {
  const res = await executeSidecarChapterVersionPublish({ versionId, userId });
  if (res.notFound || res.forbidden) {
    throw new VersionMarketError('版本不存在', 'NOT_FOUND');
  }

  return { base: 0 };
}

export async function deletePrivateVersion(versionId: string, userId: string): Promise<void> {
  const res = await executeSidecarChapterVersionDelete({ versionId, userId });
  if (res.notFound || res.forbidden) {
    throw new VersionMarketError('版本不存在', 'NOT_FOUND');
  }
  if (res.invalidState) {
    throw new VersionMarketError('已公开的版本由社区投票治理，不可删除', 'INVALID_STATE');
  }
}

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

export async function maybeFlipCanonical(
  documentId: string
): Promise<{ flipped: boolean; canonicalVersionId?: string }> {
  const res = await commitCanonicalPromotion({ documentId });
  return { flipped: res.flipped, canonicalVersionId: res.canonicalVersionId };
}

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
