import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getDynamicCreditsConfig } from '@/lib/credits-config';
import { callSidecar } from '@/lib/sidecar-client';
import { executeSidecarImportRewardGrant } from '@/engine/credits-driver';
import { settleImportBilling } from './import-billing';

const publicationSchema = z.object({
  userId: z.string().min(1),
  contentHash: z.string().min(1),
});
const reviewSchema = z.object({ publication: publicationSchema });
const rewardParamsSchema = z.object({
  kind: z.string().optional(),
  publishRequested: z.boolean().optional(),
  options: z.object({
    teachingDepth: z.string().nullable().optional(),
    repoProfile: z.object({ ingestMode: z.string().nullable().optional() }).nullable().optional(),
  }).optional(),
});
const resultSchema = z.object({ repositoryId: z.string().min(1) });
const MISSING_CONTENT = 'Content not found.';

type Database = Prisma.TransactionClient;
export type PublicationSnapshot = z.infer<typeof publicationSchema>;

/** The exact content that publication will expose: shared paths win over private duplicates. */
export async function getPublicationContent(db: Database, repositoryId: string, userId: string) {
  // Phase 1（薄行）：只取 path 锁定 winner 路径集合。排序必须沿用历史
  // localeCompare 口径——contentHash 与发布时快照逐字节一致是
  // grantImportReward 的发奖门禁，算法/顺序变更会拒发奖励。
  const thin = await db.document.findMany({
    where: { repositoryId, OR: [{ ownerUserId: null }, { ownerUserId: userId }] },
    select: { path: true },
    orderBy: { path: 'asc' },
  });
  const orderedPaths = [...new Set(thin.map((d) => d.path))].sort((a, b) => a.localeCompare(b));

  // Phase 2（分批内容）：按批回查 content，流式喂 hash——不再物化
  // 「全仓 content 数组 + 整仓 JSON.stringify 巨串」（约 3× 全仓正文的
  // V8 堆峰值；发布预检 + 事务复核每次发布各跑一遍）
  const BATCH = 100;
  async function* winnerEntries(): AsyncGenerator<{ path: string; status: string; content: string }> {
    for (let i = 0; i < orderedPaths.length; i += BATCH) {
      const batch = orderedPaths.slice(i, i + BATCH);
      const rows = await db.document.findMany({
        where: { repositoryId, path: { in: batch }, OR: [{ ownerUserId: null }, { ownerUserId: userId }] },
        select: {
          path: true, ownerUserId: true, status: true, content: true,
          contentRef: { select: { content: true } },
        },
      });
      const winnerByPath = new Map<string, (typeof rows)[number]>();
      for (const r of rows) {
        if (!winnerByPath.has(r.path) || r.ownerUserId === null) winnerByPath.set(r.path, r);
      }
      for (const path of batch) {
        const doc = winnerByPath.get(path);
        // 两阶段窗口内被并发删除（极罕见）：按未就绪处理，不掺入哈希
        if (doc) {
          yield { path: doc.path, status: doc.status, content: doc.contentRef?.content ?? doc.content ?? '' };
        } else {
          yield { path, status: 'UNPROCESSED', content: '' };
        }
      }
    }
  }

  return foldPublicationFingerprint(orderedPaths.length > 0, winnerEntries());
}

/**
 * 流式折叠发布指纹：hash 字节与旧实现 `JSON.stringify(contents)` 完全
 * 一致（"[" + 逐元素 stringify 以 "," 连接 + "]"，元素键序 path/status/content），
 * ready/totalChars/docCount 语义亦与旧 reduce/every 相同。纯函数供单测对照。
 */
export async function foldPublicationFingerprint(
  hasPaths: boolean,
  entries: AsyncIterable<{ path: string; status: string; content: string }>,
): Promise<{ ready: boolean; totalChars: number; docCount: number; contentHash: string }> {
  const hash = createHash('sha256');
  hash.update('[');
  let ready = hasPaths;
  let totalChars = 0;
  let docCount = 0;
  let first = true;
  for await (const doc of entries) {
    if (!first) hash.update(',');
    first = false;
    hash.update(JSON.stringify({ path: doc.path, status: doc.status, content: doc.content }));
    docCount++;
    if (ready && doc.status === 'PROCESSED' && doc.content.trim().length > 0 && doc.content.trim() !== MISSING_CONTENT) {
      // for-of counts Unicode code points, not UTF-16 units or UTF-8 bytes.
      for (const _point of doc.content) totalChars++;
    } else {
      ready = false;
    }
  }
  hash.update(']');
  return { ready, totalChars: ready ? totalChars : 0, docCount, contentHash: hash.digest('hex') };
}

export function publicationSnapshot(reviewPipeline: unknown): PublicationSnapshot | null {
  const parsed = reviewSchema.safeParse(reviewPipeline);
  return parsed.success ? parsed.data.publication : null;
}

/** Explicit publication is consent, even when the original import was private. */
export async function requestImportPublication(repositoryId: string, userId: string): Promise<void> {
  await callSidecar(
    '/v1/jobs/request-publication',
    { repositoryId, userId },
    { label: 'request-import-publication' }
  );
}

/** All IMPORT_REWARD writers (including retries and admin) must use this repository lock. */
export async function grantImportReward(repositoryId: string): Promise<number> {
  const config = await getDynamicCreditsConfig();
  const repo = await prisma.repository.findUnique({ where: { id: repositoryId } });
  if (!repo?.isPublic || repo.reviewStatus !== 'APPROVED' || !repo.publishedAt) return 0;
  const [hasLedger, hasPending] = await Promise.all([
    prisma.creditGrantLedger?.findFirst?.({ where: { repositoryId, source: 'IMPORT_REWARD' }, select: { id: true } }) ?? null,
    prisma.pendingCreditGrant?.findFirst?.({ where: { repositoryId }, select: { id: true } }) ?? null,
  ]);
  if (hasLedger || hasPending) return 0;
  const publication = publicationSnapshot(repo.reviewPipeline);
  if (!publication) return 0; // Legacy/public flags are not evidence of reviewed real content.
  const jobs = await prisma.importJob.findMany({
    where: {
      userId: publication.userId, status: 'COMPLETED',
      owner: repo.owner, repo: repo.repo, branch: repo.branch, edition: repo.edition,
      result: { path: ['repositoryId'], equals: repositoryId },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { params: true, result: true },
  });
  const eligible = jobs.find((job) => {
    const params = rewardParamsSchema.safeParse(job.params);
    const result = resultSchema.safeParse(job.result);
    return params.success && params.data.kind !== 'web-sync' && params.data.publishRequested === true &&
      result.success && result.data.repositoryId === repositoryId;
  });
  if (!eligible) return 0;
  const options = rewardParamsSchema.parse(eligible.params).options;
  const content = await getPublicationContent(prisma, repositoryId, publication.userId);
  if (!content.ready || content.contentHash !== publication.contentHash) return 0;
  const { rewardCredits: amount } = settleImportBilling({
    actualDocCount: content.docCount, actualChars: content.totalChars, isPublic: true, config,
    teachingDepth: options?.teachingDepth, ingestMode: options?.repoProfile?.ingestMode,
  });
  if (amount <= 0) return 0;

  const res = await executeSidecarImportRewardGrant({
    repositoryId,
    userId: publication.userId,
    amount,
    owner: repo.owner,
    repo: repo.repo,
  });

  return res.granted ? res.amount : 0;
}

/** Shared by client publication and admin approval; keep private users' other copies private. */
export async function sharePublicationDocuments(_tx: Database, repositoryId: string, userId: string) {
  await callSidecar(
    '/v1/documents/ownership/transfer',
    { repositoryId, userId },
    { label: 'share-publication-documents' }
  );
}
