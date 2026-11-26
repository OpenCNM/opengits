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

export async function getPublicationContent(db: Database, repositoryId: string, userId: string) {
  const thin = await db.document.findMany({
    where: { repositoryId, OR: [{ ownerUserId: null }, { ownerUserId: userId }] },
    select: { path: true },
    orderBy: { path: 'asc' },
  });
  // localeCompare order must match the publication contentHash gate byte-for-byte.
  const orderedPaths = [...new Set(thin.map((d) => d.path))].sort((a, b) => a.localeCompare(b));

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
      // Count Unicode code points rather than UTF-16 code units to align with reward thresholds.
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

export async function requestImportPublication(repositoryId: string, userId: string): Promise<void> {
  await callSidecar(
    '/v1/jobs/request-publication',
    { repositoryId, userId },
    { label: 'request-import-publication' }
  );
}

// Repository-scoped sidecar advisory lock serializes concurrent IMPORT_REWARD writers.
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
  if (!publication) return 0;
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

export async function sharePublicationDocuments(_tx: Database, repositoryId: string, userId: string) {
  await callSidecar(
    '/v1/documents/ownership/transfer',
    { repositoryId, userId },
    { label: 'share-publication-documents' }
  );
}
