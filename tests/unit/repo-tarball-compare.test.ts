import { test, expect, describe, vi, beforeEach } from 'vitest';
import { fetchCompareDiff, fetchRawFileHead } from '@/engine/repo-tarball';

function mockGithubClient(respond: () => Promise<Response | { ok: boolean; status: number; json?: () => Promise<unknown> }>) {
  vi.doMock('@/lib/github/client', () => ({
    githubFetch: vi.fn(respond),
  }));
}

describe('fetchCompareDiff GitHub Compare API 轻量 Diff', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('参数校验：相同 Sha 或空 Sha 直接返回 null', async () => {
    expect(await fetchCompareDiff('owner', 'repo', 'same-sha', 'same-sha')).toBeNull();
    expect(await fetchCompareDiff('owner', 'repo', '', 'new-sha')).toBeNull();
  });

  test('成功解析 GitHub Compare 响应：正确分类 added / modified / removed / renamed', async () => {
    const mockFiles = [
      { filename: 'docs/intro.md', status: 'modified' },
      { filename: 'docs/new-guide.md', status: 'added' },
      { filename: 'docs/deprecated.md', status: 'removed' },
      { filename: 'docs/v2/tutorial.md', status: 'renamed', previous_filename: 'docs/v1/tutorial.md' },
      { filename: 'src/index.ts', status: 'changed' },
    ];

    mockGithubClient(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ahead',
        ahead_by: 2,
        behind_by: 0,
        total_commits: 2,
        files: mockFiles,
      }),
    }));

    const result = await fetchCompareDiff('owner', 'repo', 'base123', 'head456', 'mock-token');
    expect(result).not.toBeNull();
    expect(result?.modified.has('docs/intro.md')).toBe(true);
    expect(result?.modified.has('src/index.ts')).toBe(true);
    expect(result?.added.has('docs/new-guide.md')).toBe(true);
    expect(result?.removed.has('docs/deprecated.md')).toBe(true);
    expect(result?.renamed).toEqual([
      { from: 'docs/v1/tutorial.md', to: 'docs/v2/tutorial.md' },
    ]);
  });

  test('截断护栏：files 达到 GitHub 300 硬上限（响应可能被截断）即返回 null 回退', async () => {
    mockGithubClient(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ahead',
        ahead_by: 400,
        behind_by: 0,
        total_commits: 1,
        files: Array.from({ length: 300 }, (_, i) => ({
          filename: `file-${i}.ts`,
          status: 'modified',
        })),
      }),
    }));

    expect(await fetchCompareDiff('owner', 'repo', 'base123', 'head456')).toBeNull();
  });

  test('截断护栏：total_commits 达到 GitHub 250 硬上限即返回 null 回退', async () => {
    mockGithubClient(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ahead',
        ahead_by: 250,
        behind_by: 0,
        total_commits: 250,
        files: [{ filename: 'docs/a.md', status: 'modified' }],
      }),
    }));

    expect(await fetchCompareDiff('owner', 'repo', 'base123', 'head456')).toBeNull();
  });

  test('分叉护栏：status=diverged（force-push 后三点 diff 语义失真）返回 null 回退双归档', async () => {
    mockGithubClient(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'diverged',
        ahead_by: 1,
        behind_by: 2,
        total_commits: 1,
        files: [{ filename: 'docs/a.md', status: 'modified' }],
      }),
    }));

    expect(await fetchCompareDiff('owner', 'repo', 'base123', 'head456')).toBeNull();
  });

  test('HTTP 错误或超限时安全返回 null 触发降级', async () => {
    mockGithubClient(async () => ({
      ok: false,
      status: 404,
    }));

    const result = await fetchCompareDiff('owner', 'repo', 'base123', 'head456');
    expect(result).toBeNull();
  });
});

describe('fetchRawFileHead raw 文件头部采样', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('参数校验：空 Sha 或空路径直接返回 null', async () => {
    expect(await fetchRawFileHead('owner', 'repo', '', 'a.md', 10)).toBeNull();
    expect(await fetchRawFileHead('owner', 'repo', 'sha1', '', 10)).toBeNull();
  });

  test('成功：仅读取前 maxBytes 字节即断流（路径含空格正确编码）', async () => {
    mockGithubClient(async () => new Response('0123456789'));

    const head = await fetchRawFileHead('owner', 'repo', 'abc1234', 'docs/a b.md', 4, 'mock-token');
    expect(head).toBe('0123');
  });

  test('HTTP 错误安全返回 null', async () => {
    mockGithubClient(async () => ({
      ok: false,
      status: 404,
    }));

    expect(await fetchRawFileHead('owner', 'repo', 'abc1234', 'docs/missing.md', 10)).toBeNull();
  });
});
