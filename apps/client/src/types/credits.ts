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
