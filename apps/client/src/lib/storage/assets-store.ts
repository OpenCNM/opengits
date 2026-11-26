import { getStorageDriver } from './driver';

export function assetObjectKey(owner: string, repo: string, relPath: string): string {
  return `assets/${owner}/${repo}/${relPath}`;
}

export async function putAsset(owner: string, repo: string, relPath: string, data: Buffer): Promise<void> {
  await getStorageDriver().put(assetObjectKey(owner, repo, relPath), data);
}

export async function getAsset(owner: string, repo: string, relPath: string): Promise<Buffer | null> {
  return getStorageDriver().get(assetObjectKey(owner, repo, relPath));
}

export async function assetExists(owner: string, repo: string, relPath: string): Promise<boolean> {
  return getStorageDriver().exists(assetObjectKey(owner, repo, relPath));
}

export function activeStorageDriverName(): string {
  return getStorageDriver().name;
}
