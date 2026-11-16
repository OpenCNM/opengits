/**
 * apps/client/src/lib/search/binary-index-service.ts
 *
 * Repository Binary Search Index Generator & Storage Service.
 *
 * Single Source of Truth for:
 * - Chunk extraction from Prisma Document & DocumentChunk
 * - Multilingual CJK & Code Identifier tokenization
 * - Inverted Index packing (OGIS v1)
 * - Object storage persistence via MinIO / S3 (putAsset / getAsset)
 * - JIT self-healing cache resolution
 */

import { prisma } from '@/lib/db';
import { DocumentStatus } from '@/lib/constants';
import { ENGINE_CONFIG } from '@/lib/config';
import { putAsset, getAsset, assetExists } from '@/lib/storage/assets-store';
import { packSearchIndex, type RawChunkRecord } from './binary-index-packer';
import { extractContextSnippet } from './snippet';
import { tokenizeSearchText } from './binary-index-tokenizer';
import { buildRepoBinaryIndexViaSidecar } from '@/engine/search-driver';
export { tokenizeSearchText };

/**
 * 按仓去抖调度索引重建：finalize 每篇文档都触发一次 O(全仓) 的重建，
 * 批量导入 N 篇 = N 次全仓分词+打包+压缩。这里把同仓连续触发合并为
 * 「末次触发 + 去抖窗口后重建一次」（trailing debounce）。
 * JIT 读取端有 self-healing 兜底：去抖窗口内的读取若命中缺失索引会现场重建。
 */
const pendingRebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleRepoBinaryIndexRefresh(repositoryId: string): void {
  // 写权归属 Go sidecar 时 no-op（SEARCH_INDEX_GO_BUILDER=1：
  // Go 侧转录收尾直触发 + sweep 兜底；Node JIT 读取兜底不受影响）
  if (ENGINE_CONFIG.search.binaryIndexBuilder === 'go') return;

  const existing = pendingRebuildTimers.get(repositoryId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingRebuildTimers.delete(repositoryId);
    generateRepoBinaryIndex(repositoryId).catch((err) => {
      console.warn(`[BinaryIndexService] debounced rebuild failed for repo ${repositoryId}:`, err);
    });
  }, ENGINE_CONFIG.search.binaryIndexRebuildDebounceMs);

  // 定时器不阻止进程退出（worker 收尾/优雅停机场景）
  timer.unref?.();
  pendingRebuildTimers.set(repositoryId, timer);
}

/** 观测/测试：当前挂起的去抖重建仓集合 */
export function __pendingIndexRebuildsForTests(): string[] {
  return Array.from(pendingRebuildTimers.keys());
}

/** 生成并存储给定仓库的二进制搜索索引到 MinIO。 */
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

  // 双归属 OR-JOIN（与 Go 侧 ogisChunkJoinSQL / doc-search chunkJoinSQL 对齐）：
  // legacy chunk 挂 documentId；内容层 chunk 只挂 contentId（停写模式 DUAL_WRITE=0 下
  // legacy 行被删）。旧的关系查询只走 documentId——停写后会静默产出空索引，此为修正。
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
    // If no chunks, return an empty index
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

  // Convert chunks to RawChunkRecords with tokenization
  const rawChunks: RawChunkRecord[] = chunks.map((c) => {
    const docPath = c.path || '';
    const title = c.title || '';
    const heading = c.heading || '';
    const content = c.content || '';

    // Tokens aggregated from title, heading, and content
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

  // Persist into MinIO / S3 storage
  const assetKey = `search-index-${gitSha}.bin`;
  await putAsset(repository.owner, repository.repo, assetKey, packedBuffer);

  return packedBuffer;
}

/**
 * JIT: Retrieves or on-demand generates the binary search index for an owner/repo from MinIO.
 * 单飞合并（single-flight）：并发读者 miss 时共享同一次重建 Promise，避免同仓被重复整仓打包。
 */
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

  // 1. Try reading from MinIO / object storage
  const existing = await getAsset(owner, repo, assetKey);
  if (existing) {
    return { buffer: existing, gitSha };
  }

  // 2. JIT: Generate, persist to storage, and return（同仓并发 miss 共享一次重建）
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
