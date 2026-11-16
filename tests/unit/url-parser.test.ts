import { test, expect, describe } from 'vitest';
import { parseGithubUrl } from '@/lib/url-parser';
import { ENGINE_CONFIG } from '@/lib/config';

describe('url-parser GitHub URL 与意图解析', () => {
  test('短语法 owner/repo 与 .git 尾缀', () => {
    const res1 = parseGithubUrl('facebook/react');
    expect(res1).toEqual({
      owner: 'facebook',
      repo: 'react',
      branch: ENGINE_CONFIG.defaultBranch,
      filePath: null,
      isBlobUrl: false,
      rawUrl: 'facebook/react',
    });

    const res2 = parseGithubUrl('vercel/next.js.git');
    expect(res2?.owner).toBe('vercel');
    expect(res2?.repo).toBe('next.js');
    expect(res2?.branch).toBe(ENGINE_CONFIG.defaultBranch);
  });

  test('SSH 协议格式 git@github.com 与 git:// 格式', () => {
    const ssh = parseGithubUrl('git@github.com:torvalds/linux.git');
    expect(ssh).toEqual({
      owner: 'torvalds',
      repo: 'linux',
      branch: ENGINE_CONFIG.defaultBranch,
      filePath: null,
      isBlobUrl: false,
      rawUrl: 'git@github.com:torvalds/linux.git',
    });

    const gitProto = parseGithubUrl('git://github.com/expressjs/express.git');
    expect(gitProto).toEqual({
      owner: 'expressjs',
      repo: 'express',
      branch: ENGINE_CONFIG.defaultBranch,
      filePath: null,
      isBlobUrl: false,
      rawUrl: 'git://github.com/expressjs/express.git',
    });
  });

  test('HTTPS 仓库根路径', () => {
    const res1 = parseGithubUrl('https://github.com/vuejs/core');
    expect(res1).toEqual({
      owner: 'vuejs',
      repo: 'core',
      branch: ENGINE_CONFIG.defaultBranch,
      filePath: null,
      isBlobUrl: false,
      rawUrl: 'https://github.com/vuejs/core',
    });

    const res2 = parseGithubUrl('http://github.com/tailwindlabs/tailwindcss.git');
    expect(res2?.owner).toBe('tailwindlabs');
    expect(res2?.repo).toBe('tailwindcss');
  });

  test('Blob 单文件 URL 识别（isBlobUrl = true + filePath + branch）', () => {
    const blob = parseGithubUrl('https://github.com/owner/repo/blob/release-v2/docs/getting-started.md');
    expect(blob).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'release-v2',
      filePath: 'docs/getting-started.md',
      isBlobUrl: true,
      rawUrl: 'https://github.com/owner/repo/blob/release-v2/docs/getting-started.md',
    });

    const deepBlob = parseGithubUrl('https://github.com/a/b/blob/main/deep/nested/folder/file.py');
    expect(deepBlob?.isBlobUrl).toBe(true);
    expect(deepBlob?.filePath).toBe('deep/nested/folder/file.py');
    expect(deepBlob?.branch).toBe('main');
  });

  test('Tree 目录/分支 URL 识别（isBlobUrl = false + filePath）', () => {
    const treeDir = parseGithubUrl('https://github.com/owner/repo/tree/develop/packages/core');
    expect(treeDir).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'develop',
      filePath: 'packages/core',
      isBlobUrl: false,
      rawUrl: 'https://github.com/owner/repo/tree/develop/packages/core',
    });

    const branchOnly = parseGithubUrl('https://github.com/owner/repo/tree/feat-123');
    expect(branchOnly?.branch).toBe('feat-123');
    expect(branchOnly?.filePath).toBeNull();
    expect(branchOnly?.isBlobUrl).toBe(false);
  });

  test('异常输入与非 GitHub 域名防御', () => {
    expect(parseGithubUrl('')).toBeNull();
    expect(parseGithubUrl(null as any)).toBeNull();
    expect(parseGithubUrl(undefined as any)).toBeNull();
    expect(parseGithubUrl('https://gitlab.com/owner/repo')).toBeNull();
    expect(parseGithubUrl('https://gitee.com/owner/repo')).toBeNull();
    expect(parseGithubUrl('https://github.com/')).toBeNull();
    expect(parseGithubUrl('https://github.com/onlyonepart')).toBeNull();
    expect(parseGithubUrl('not-a-valid-url-at-all')).toBeNull();
  });
});
