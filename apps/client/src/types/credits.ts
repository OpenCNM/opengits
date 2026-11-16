/**
 * apps/client/src/types/credits.ts
 *
 * 积分经济与分阶段归属（Vesting Model）TypeScript 契约层
 * （2026-11 积分域清理：零消费的 schema 再导出块已拆除，仅存两个在役
 *  Result 接口；状态机词汇与路由入参 schema 见 lib/schemas/credit-grant.ts）
 */

export interface UnpublishRepositoryResult {
  success: boolean;
  isPublic: boolean;
  unpublishCooldownUntil?: string | null;
  cancelledPendingGrantsCount: number;
  detachedSavedReposCount: number;
  message: string;
}

export interface PromoteEditionResult {
  success: boolean;
  repositoryId: string;
  owner: string;
  repo: string;
  branch: string;
  oldDefaultRepoId?: string;
  migratedSavesCount: number;
  message: string;
}

