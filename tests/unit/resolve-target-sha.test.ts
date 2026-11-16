import { test, expect, describe, vi, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import { TARBALL_CACHE } from '@/lib/config';
import { resolveTargetSha, findLatestLocalArchiveSha } from '@/engine/repo-tarball';

describe('resolveTargetSha Git SHA 终极收敛与归一', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('40位十六进制 SHA 原样小写直通 (0 网络开销)', async () => {
    const rawSha = 'A8B13931CA7E44F5C0C428CF33E785AD2E8D51FA';
    const result = await resolveTargetSha('huggingface', 'peft', rawSha);
    expect(result).toBe('a8b13931ca7e44f5c0c428cf33e785ad2e8d51fa');
  });

  test('分支名通过本地缓存物理事实回退解析', async () => {
    // 确保本地存在缓存目录以验证缓存命中与回退机制（测试隔离与密闭性）
    const fixtureSha = 'a8b13931ca7e44f5c0c428cf33e785ad2e8d51fa';
    const fixtureDir = path.join(TARBALL_CACHE.dir, 'huggingface', 'peft', fixtureSha);
    await fs.ensureDir(fixtureDir);

    const cachedSha = await findLatestLocalArchiveSha('huggingface', 'peft');
    expect(cachedSha).toMatch(/^[0-9a-f]{40}$/);

    // 针对任意不存在的分支，在网络模拟失败时，应无缝回退到本地物理磁盘已有归档
    vi.spyOn(await import('@/engine/tarball/github-api'), 'resolveLatestSha').mockRejectedValueOnce(
      new Error('API rate limit exceeded')
    );

    const result = await resolveTargetSha('huggingface', 'peft', 'non-existent-branch-test');
    expect(result).toBe(cachedSha);
  });

  test('空 ref 缺省等价于 HEAD，能正常解析', async () => {
    const result = await resolveTargetSha('huggingface', 'peft', '');
    expect(result).toMatch(/^[0-9a-f]{40}$/);
  });
});
