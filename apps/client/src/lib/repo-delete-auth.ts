import { prisma } from '@/lib/db';

/**
 * DELETE /api/repos 的全局删除授权判定（纯决策函数，查询由调用方注入）。
 *
 * 语义矩阵（审计矩阵 BUG-GEN-01 修复 + 红队 GAP-1 回归修复）：
 * - 公开仓：全局删除是平台治理动作，仅管理员/ENTERPRISE 可执行（owner 也不行——
 *   公开内容是社区资产，防止单人删除公共教程）。
 * - 私有仓：属主（在该仓持有 ownerUserId 归属私有文档的导入者）可删自己的仓；
 *   其余非特权用户一律拒绝。
 * - 管理员/ENTERPRISE：全量放行。
 */
export interface RepoDeleteAuthInput {
  actor: { role: string; tier: string } | null;
  isPrivileged: boolean;
  repoIsPublic: boolean;
  /** 调用方在该仓持有私有文档（ownerUserId 归属）的查询结果 */
  ownsPrivateDocs: boolean;
  globalDelete: boolean;
}

export function canGloballyDeleteRepo(input: RepoDeleteAuthInput): boolean {
  // 防御：调用方未提供操作者身份时不放行（即使归属证据存在）
  if (!input.actor) return false;
  if (input.isPrivileged) return true;
  // 公开仓 = 社区资产，非特权用户永远不能全局删除（无论是否携带 global 参数）
  if (input.repoIsPublic) return false;
  // 私有仓：属主可删自己的仓
  return input.ownsPrivateDocs;
}

/** 查询调用方是否为该仓私有文档的属主（私有仓删除授权的证据查询） */
export async function userOwnsPrivateDocs(repositoryId: string, userId: string): Promise<boolean> {
  const owned = await prisma.document.findFirst({
    where: { repositoryId, ownerUserId: userId },
    select: { id: true },
  });
  if (owned) return true;

  const imported = await prisma.importRecord.findFirst({
    where: { repositoryId, userId },
    select: { id: true },
  });
  if (imported) return true;

  const saved = await prisma.savedRepo.findFirst({
    where: { repositoryId, userId },
    select: { id: true },
  });
  return Boolean(saved);
}
