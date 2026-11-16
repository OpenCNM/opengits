import path from 'path';

/**
 * assets 物理路径定义点（Phase 0 T6：收敛三处内联魔法路径）。
 * local 驱动与历史目录结构同构：storage/assets/{owner}/{repo}/...
 */

export function getAssetsRootDir(): string {
  return path.join(process.cwd(), 'storage', 'assets');
}

export function getRepoAssetsDir(owner: string, repo: string): string {
  return path.join(getAssetsRootDir(), owner, repo);
}
