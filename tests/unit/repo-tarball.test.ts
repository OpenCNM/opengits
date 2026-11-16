import { test, expect, describe, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'fs-extra';
import {
  assertSafeSegments,
  archiveDirFor,
  hasLocalArchive,
  diffArchives,
  treeFromArchive,
  readFileLocal,
  copyFileLocal,
  cleanupOrphanTmpDirs,
  purgeRepoCache,
} from '@/engine/repo-tarball';
import { TARBALL_CACHE } from '@/lib/config';

vi.mock('@/engine/diff-driver', () => ({
  // 归档差异已下沉 Go（Fail-Closed 单实现）——回放空差异
  executeArchiveDiff: async () => null,
}));

vi.mock('@/engine/tarball/archive-sidecar-driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/tarball/archive-sidecar-driver')>();
  return {
    ...actual,
    diffArchivesViaSidecar: vi.fn(async (_o, _r, oldSha) => {
      if (oldSha === '3333333333333333333333333333333333333333') return null;
      return {
        added: new Set(['added.md']),
        modified: new Set(['modified.md']),
        removed: new Set(['deleted.md']),
        renamed: [{ from: 'old-name.md', to: 'new-name.md' }],
      };
    }),
  };
});

describe('repo-tarball 路径安全与沙箱防护', () => {
  test('assertSafeSegments：合法段通过，非法字符与穿越抛错', () => {
    // 合法参数
    expect(() => assertSafeSegments('facebook', 'react', 'a1b2c3d')).not.toThrow();
    expect(() => assertSafeSegments('vercel', 'next.js', '0123456789abcdef0123456789abcdef01234567')).not.toThrow();
    expect(() => assertSafeSegments('org-name_v1.0', 'my-repo_test.2', 'deadbeef')).not.toThrow();

    // 非法 owner/repo（含路径穿越、特殊字符、空格）
    expect(() => assertSafeSegments('../evil', 'react', 'a1b2c3d')).toThrow(/Invalid owner\/repo segment/);
    expect(() => assertSafeSegments('facebook', 'react/nested', 'a1b2c3d')).toThrow(/Invalid owner\/repo segment/);
    expect(() => assertSafeSegments('owner', 'repo:name', 'a1b2c3d')).toThrow(/Invalid owner\/repo segment/);
    expect(() => assertSafeSegments('owner', 'repo name', 'a1b2c3d')).toThrow(/Invalid owner\/repo segment/);
    expect(() => assertSafeSegments('owner', '', 'a1b2c3d')).toThrow(/Invalid owner\/repo segment/);

    // 非法 sha（长度不足 7 位、超过 40 位、非 hex 字符）
    expect(() => assertSafeSegments('owner', 'repo', '123456')).toThrow(/Invalid sha segment/);
    expect(() => assertSafeSegments('owner', 'repo', 'g123456')).toThrow(/Invalid sha segment/);
    expect(() => assertSafeSegments('owner', 'repo', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5')).toThrow(/Invalid sha segment/);
    expect(() => assertSafeSegments('owner', 'repo', '../etc')).toThrow(/Invalid sha segment/);
  });

  test('archiveDirFor：安全拼接规范路径', () => {
    const dir = archiveDirFor('test-owner', 'test-repo', '1234567');
    expect(dir).toBe(path.join(TARBALL_CACHE.dir, 'test-owner', 'test-repo', '1234567'));
  });
});

describe('repo-tarball 增量 Diff 与改名配对', () => {
  const testOwner = 'test-diff-owner';
  const testRepo = 'test-diff-repo';
  const oldSha = '1111111111111111111111111111111111111111';
  const newSha = '2222222222222222222222222222222222222222';
  const oldDir = archiveDirFor(testOwner, testRepo, oldSha);
  const newDir = archiveDirFor(testOwner, testRepo, newSha);

  beforeAll(async () => {
    await fs.ensureDir(oldDir);
    await fs.ensureDir(newDir);

    // 旧版本文件
    await fs.writeFile(path.join(oldDir, 'unchanged.md'), '# Unchanged content');
    await fs.writeFile(path.join(oldDir, 'modified.md'), '# Old content');
    await fs.writeFile(path.join(oldDir, 'deleted.md'), '# Deleted content');
    await fs.writeFile(path.join(oldDir, 'old-name.md'), '# Content to be renamed');

    // 新版本文件
    await fs.writeFile(path.join(newDir, 'unchanged.md'), '# Unchanged content');
    await fs.writeFile(path.join(newDir, 'modified.md'), '# New modified content');
    await fs.writeFile(path.join(newDir, 'added.md'), '# Newly added content');
    await fs.writeFile(path.join(newDir, 'new-name.md'), '# Content to be renamed'); // hash 与 old-name.md 完全一致
  });

  afterAll(async () => {
    await fs.remove(path.join(TARBALL_CACHE.dir, testOwner)).catch(() => undefined);
  });


  test('diffArchives：归档不存在时返回 null', async () => {
    const diff = await diffArchives(testOwner, testRepo, '3333333333333333333333333333333333333333', newSha);
    expect(diff).toBeNull();
  });
});

describe('repo-tarball 本地读取与文件操作安全', () => {
  const testOwner = 'test-io-owner';
  const testRepo = 'test-io-repo';
  const testSha = '4444444444444444444444444444444444444444';
  const archiveDir = archiveDirFor(testOwner, testRepo, testSha);
  const tempDestDir = path.join(TARBALL_CACHE.dir, 'temp-dest-dir');

  beforeAll(async () => {
    await fs.ensureDir(path.join(archiveDir, 'docs', 'nested'));
    await fs.writeFile(path.join(archiveDir, 'docs', 'hello.md'), '# Hello World from Tarball\nSecond Line\nThird Line');
    await fs.writeFile(path.join(archiveDir, 'docs', 'nested', 'detail.txt'), 'Deep nested content');
    await fs.ensureDir(tempDestDir);
  });

  afterAll(async () => {
    await fs.remove(path.join(TARBALL_CACHE.dir, testOwner)).catch(() => undefined);
    await fs.remove(tempDestDir).catch(() => undefined);
  });

  test('hasLocalArchive：存在返回 true，不存在或空 sha 返回 false', async () => {
    expect(await hasLocalArchive(testOwner, testRepo, testSha)).toBe(true);
    expect(await hasLocalArchive(testOwner, testRepo, '5555555555555555555555555555555555555555')).toBe(false);
    expect(await hasLocalArchive(testOwner, testRepo, '')).toBe(false);
  });

  
  test('readFileLocal：全量读取与 maxBytes 头部截断读取', async () => {
    const full = await readFileLocal(testOwner, testRepo, testSha, 'docs/hello.md');
    expect(full).toContain('# Hello World from Tarball');

    const partial = await readFileLocal(testOwner, testRepo, testSha, 'docs/hello.md', 13);
    expect(partial).toBe('# Hello World');

    const notFound = await readFileLocal(testOwner, testRepo, testSha, 'docs/missing.md');
    expect(notFound).toBeNull();
  });

  test('readFileLocal：防路径穿越拦截', async () => {
    await expect(
      readFileLocal(testOwner, testRepo, testSha, '../../outside.txt')
    ).rejects.toThrow(/Path traversal blocked/);
  });

  test('copyFileLocal：正常复制与源路径穿越拦截', async () => {
    const copied = await copyFileLocal(testOwner, testRepo, testSha, 'docs/hello.md', tempDestDir);
    expect(copied).toBe(true);
    expect(await fs.pathExists(path.join(tempDestDir, 'docs', 'hello.md'))).toBe(true);

    // 路径穿越拦截
    await expect(
      copyFileLocal(testOwner, testRepo, testSha, '../../evil.md', tempDestDir)
    ).rejects.toThrow(/Path traversal blocked/);
  });
});

describe('repo-tarball 孤儿清理与 GC 清扫', () => {
  const orphanOwner = 'test-orphan-owner';
  const orphanRepo = 'test-orphan-repo';
  const orphanDir = path.join(TARBALL_CACHE.dir, orphanOwner, orphanRepo);

  test('cleanupOrphanTmpDirs：递归删除 .tmp-* 孤儿目录', async () => {
    const tmp1 = path.join(orphanDir, 'test-sha.tmp-123456');
    const tmp2 = path.join(orphanDir, 'test-sha.tmp-789012');
    const normal = path.join(orphanDir, '7777777777777777777777777777777777777777');
    await fs.ensureDir(tmp1);
    await fs.ensureDir(tmp2);
    await fs.ensureDir(normal);

    const result = await cleanupOrphanTmpDirs();
    expect(result.removed).toBeGreaterThanOrEqual(2);
    expect(await fs.pathExists(tmp1)).toBe(false);
    expect(await fs.pathExists(tmp2)).toBe(false);
    expect(await fs.pathExists(normal)).toBe(true);

    await fs.remove(path.join(TARBALL_CACHE.dir, orphanOwner)).catch(() => undefined);
  });
});
