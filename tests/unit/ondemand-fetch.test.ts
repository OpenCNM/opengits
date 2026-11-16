import { test, expect, describe, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import { ensureArchive, archiveDirFor } from '@/engine/repo-tarball';
import { setCachedTree, hydrateTreeFromDisk } from '@/lib/tree-cache';
import { TARBALL_CACHE } from '@/lib/config';

describe('ensureArchive 下载前体积预检（sizeHint）', () => {
  test('超 cap 的 hint → 秒回 {dir:null} 且不落任何目录（无网络下载）', async () => {
    const owner = 'precheck-owner';
    const repo = 'precheck-repo';
    const sha = 'aabbccddeeff00112233445566778899aabbccdd';
    const result = await ensureArchive(owner, repo, sha, undefined, undefined, TARBALL_CACHE.entryCapBytes + 1);
    expect(result).toEqual({ dir: null, fromCache: false });
    // 未发生下载：目标目录与任何 tmp 残留都不存在
    expect(await fs.pathExists(archiveDirFor(owner, repo, sha))).toBe(false);
    const repoDir = archiveDirFor(owner, repo, sha).replace(/[\\/]aabbccd.*$/, '');
    const entries = await fs.readdir(repoDir).catch(() => [] as string[]);
    expect(entries.filter((e) => e.includes('.tmp-'))).toHaveLength(0);
  });
});

describe('tree-cache 磁盘持久化（进程重启免冷拉取）', () => {
  test('set 落盘 + hydrate 读回（含数组附加属性）', async () => {
    const owner = 'tree-persist-test-owner';
    const repo = 'test-repo';
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    const tree = Object.assign(
      [
        { path: 'docs/a.md', type: 'blob', mode: '100644', size: 10, sha: '', url: '' },
        { path: 'docs', type: 'tree', mode: '040000', sha: '', url: '' },
      ],
      { truncated: false }
    );
    setCachedTree(owner, repo, sha, tree as any);
    // 落盘为 fire-and-forget，等写入完成
    await new Promise((r) => setTimeout(r, 500));

    // hydrate 走磁盘读回（新进程冷启动的回填路径），数组附加属性不丢
    const hydrated = await hydrateTreeFromDisk(owner, repo, sha);
    expect(hydrated).toBeTruthy();
    expect(hydrated).toHaveLength(2);
    expect(hydrated![0].path).toBe('docs/a.md');
    expect((hydrated as any).truncated).toBe(false);

    // 清理测试产物
    const dir = path.join(process.cwd(), 'storage', 'trees');
    for (const f of await fs.readdir(dir)) {
      if (f.includes(owner)) await fs.remove(path.join(dir, f)).catch(() => undefined);
    }
  }, 30000);
});
