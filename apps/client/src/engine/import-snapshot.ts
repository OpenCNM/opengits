// 导入快照共用逻辑（ingest.ts 与 code-ingest.ts 共用，避免两者循环依赖）。
//
// 真冻结语义的两块基石：
// 1. 文档归属：私有导入 → ownerUserId = 当前用户；公开导入 → ownerUserId = null（共享）。
//    读取方统一按 ownerUserId IS NULL OR ownerUserId = userId 过滤。
// 2. 导入快照：ImportRecord 记录每个用户每次导入的 commit sha；
//    同一用户再次导入且 sha 变化 → 重置该用户自己的文档（content=null, UNPROCESSED），
//    从新 sha 重新生成；其他用户的文档永不触碰。

import type { Prisma } from '@prisma/client';
import { DocumentStatus } from '../lib/constants';
import { callSidecar } from '../lib/sidecar-client';

interface RegisterImportSnapshotParams {
  userId?: string | null;
  repositoryId: string;
  owner: string;
  repo: string;
  branch: string;
  sha: string | null;
  prefix?: string | null;
  /** 该次导入的文档归属 id（reset 只重置归属者自己的文档） */
  docOwnerId: string | null;
  /**
   * 增量更新 diff（可选）：旧 sha 归档 + 新 sha 归档都在本地时，
   * 仅重置 changed 路径 + 删除 removed 路径（省钱）；缺省全量重置。
   */
  diff?: { changed: Set<string>; removed: Set<string> } | null;
  /**
   * 跳过文档重置（仅推进 ImportRecord）：update-applier 按 LLM 计划
   * 精确处理文档后调用，避免 registerImportSnapshot 再触发全量/增量重置。
   */
  skipDocumentReset?: boolean;
}

/**
 * 事务内：ImportRecord upsert（IMPORTED/UPDATED）+ 同用户 sha 变化时重置其文档。
 * 返回 shaChanged 供调用方记录日志。
 */
export async function registerImportSnapshot(
  _tx: Prisma.TransactionClient,
  params: RegisterImportSnapshotParams
): Promise<{ shaChanged: boolean }> {
  const { userId, repositoryId, owner, repo, branch, sha, prefix, docOwnerId, diff, skipDocumentReset } = params;
  if (!userId || !sha) return { shaChanged: false };

  const res = await callSidecar<{ ok: boolean; shaChanged: boolean }>(
    '/v1/ingest/snapshot/register',
    {
      userId,
      repositoryId,
      owner,
      repo,
      branch,
      sha,
      prefix: prefix ?? null,
      docOwnerId: docOwnerId ?? null,
      changed: diff?.changed ? [...diff.changed] : [],
      removed: diff?.removed ? [...diff.removed] : [],
      skipDocumentReset: Boolean(skipDocumentReset),
    },
    { label: 'ingest-snapshot-register' }
  );

  return { shaChanged: Boolean(res?.shaChanged) };
}
