import path from 'path';

export function getAssetsRootDir(): string {
  return path.join(process.cwd(), 'storage', 'assets');
}

export function getRepoAssetsDir(owner: string, repo: string): string {
  return path.join(getAssetsRootDir(), owner, repo);
}
