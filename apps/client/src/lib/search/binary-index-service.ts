import { prisma } from '@/lib/db';
import { DocumentStatus } from '@/lib/constants';
import { ENGINE_CONFIG } from '@/lib/config';
import { putAsset, getAsset, assetExists } from '@/lib/storage/assets-store';
import { packSearchIndex, type RawChunkRecord } from './binary-index-packer';
import { extractContextSnippet } from './snippet';
import { tokenizeSearchText } from './binary-index-tokenizer';
import { buildRepoBinaryIndexViaSidecar } from '@/engine/search-driver';
export { tokenizeSearchText };

// Trailing debounce merges batch finalize rebuilds; Go builder skips Node rebuilds unless binaryIndexBuilder === node.
const pendingRebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleRepoBinaryIndexRefresh(repositoryId: string): void {
  if (ENGINE_CONFIG.search.binaryIndexBuilder === 'go') return;

  const existing = pendingRebuildTimers.get(repositoryId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingRebuildTimers.delete(repositoryId);
    generateRepoBinaryIndex(repositoryId).catch((err) => {
      console.warn(`[BinaryIndexService] debounced rebuild failed for repo ${repositoryId}:`, err);
    });
  }, ENGINE_CONFIG.search.binaryIndexRebuildDebounceMs);

  timer.unref?.();
  pendingRebuildTimers.set(repositoryId, timer);
}

export function __pendingIndexRebuildsForTests(): string[] {
  return Array.from(pendingRebuildTimers.keys());
}

export async function generateRepoBinaryIndex(repositoryId: string): Promise<Buffer | null> {
  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: {
      id: true,
      owner: true,
      repo: true,
      gitSha: true,
    },
  });

  if (!repository) return null;

  const gitSha = repository.gitSha || 'head';

  // OR-join covers both legacy documentId chunks and content-addressed contentId chunks.
  const rows = await prisma.$queryRaw<
    Array<{
      chunkId: string;
      heading: string | null;
      headingPath: string | null;
      content: string;
      title: string | null;
      path: string | null;
    }>
  >`
    SELECT DISTINCT ch."id" AS "chunkId", ch."heading", ch."headingPath", ch."content",
           d."title", d."path", ch."order"
    FROM "DocumentChunk" ch
    JOIN "Document" d ON (
      (ch."documentId" IS NOT NULL AND d."id" = ch."documentId")
      OR (ch."contentId" IS NOT NULL AND d."contentId" = ch."contentId")
    )
    WHERE d."repositoryId" = ${repository.id}
      AND d."status" = ${DocumentStatus.PROCESSED}
    ORDER BY d."path" ASC, ch."order" ASC NULLS LAST, ch."id" ASC`;
  const chunks = rows;

  if (chunks.length === 0) {
    const emptyIndex = packSearchIndex({
      owner: repository.owner,
      repo: repository.repo,
      gitSha,
      chunks: [],
    }, true, ENGINE_CONFIG.search.binaryIndexGzipLevel);
    const assetKey = `search-index-${gitSha}.bin`;
    await putAsset(repository.owner, repository.repo, assetKey, emptyIndex);
    return emptyIndex;
  }

  const rawChunks: RawChunkRecord[] = chunks.map((c) => {
    const docPath = c.path || '';
    const title = c.title || '';
    const heading = c.heading || '';
    const content = c.content || '';

    const searchableText = `${title} ${heading} ${content}`;
    const tokens = tokenizeSearchText(searchableText);

    return {
      id: c.chunkId,
      docPath,
      title,
      heading: c.heading,
      headingPath: c.headingPath,
      content: extractContextSnippet(content, '', 160) || content.slice(0, 160),
      tokens,
    };
  });

  const packedBuffer = packSearchIndex({
    owner: repository.owner,
    repo: repository.repo,
    gitSha,
    chunks: rawChunks,
  }, true, ENGINE_CONFIG.search.binaryIndexGzipLevel);

  const assetKey = `search-index-${gitSha}.bin`;
  await putAsset(repository.owner, repository.repo, assetKey, packedBuffer);

  return packedBuffer;
}

// Singleflight deduplicates concurrent cold-cache index builds per repo.
const inFlightGenerations = new Map<string, Promise<Buffer | null>>();

export async function getOrGenerateRepoBinaryIndex(
  owner: string,
  repo: string,
  targetGitSha?: string,
): Promise<{ buffer: Buffer; gitSha: string } | null> {
  const repository = await prisma.repository.findFirst({
    where: { owner, repo },
    select: {
      id: true,
      owner: true,
      repo: true,
      gitSha: true,
    },
  });

  if (!repository) return null;

  const gitSha = targetGitSha || repository.gitSha || 'head';
  const assetKey = `search-index-${gitSha}.bin`;

  const existing = await getAsset(owner, repo, assetKey);
  if (existing) {
    return { buffer: existing, gitSha };
  }

  let generation = inFlightGenerations.get(repository.id);
  if (!generation) {
    generation = (async () => {
      if (ENGINE_CONFIG.search.binaryIndexBuilder === 'go') {
        try {
          await buildRepoBinaryIndexViaSidecar(repository.id);
          const fresh = await getAsset(owner, repo, assetKey);
          if (fresh) return fresh;
          console.warn(
            `[BinaryIndexService] Sidecar reported index built for repo ${repository.id} but asset ${assetKey} not found in storage, falling back to local generator`
          );
        } catch (err) {
          console.warn(
            `[BinaryIndexService] Sidecar index build failed for repo ${repository.id}, falling back to local generator:`,
            err
          );
        }
      }
      return generateRepoBinaryIndex(repository.id);
    })().finally(() => {
      inFlightGenerations.delete(repository.id);
    });
    inFlightGenerations.set(repository.id, generation);
  }
  const newlyGenerated = await generation;
  if (!newlyGenerated) return null;

  return { buffer: newlyGenerated, gitSha };
}
