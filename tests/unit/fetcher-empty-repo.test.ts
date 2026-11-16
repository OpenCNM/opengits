import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Fetcher, EmptyRepoError } from '@/engine/fetcher';

describe('Fetcher empty repository handling (Item 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws EmptyRepoError with code EMPTY_REPO when GitHub returns 409 Conflict', async () => {
    const fetcher = new Fetcher('owner', 'empty-repo', 'main');
    vi.spyOn(fetcher as any, 'gh').mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'Conflict (Git Repository is empty)',
    });

    await expect(fetcher.getRepoTree(1)).rejects.toThrowError(EmptyRepoError);
    await expect(fetcher.getRepoTree(1)).rejects.toMatchObject({
      code: 'EMPTY_REPO',
      statusCode: 422,
      message: '仓库没有任何可读内容（空仓库或全部文件被忽略）',
    });
  });

  it('throws EmptyRepoError with code EMPTY_REPO when tree is an empty array', async () => {
    const fetcher = new Fetcher('owner', 'empty-repo', 'main');
    vi.spyOn(fetcher as any, 'gh').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tree: [] }),
    });

    await expect(fetcher.getRepoTree(1)).rejects.toThrowError(EmptyRepoError);
  });

  it('throws EmptyRepoError after one bounded 404 retry (persistent miss), absorbing transient 404s', async () => {
    const fetcher = new Fetcher('owner', 'not-found-repo', 'main');
    let callCount = 0;
    vi.spyOn(fetcher as any, 'gh').mockImplementation(async () => {
      callCount++;
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      };
    });

    await expect(fetcher.getRepoTree(3)).rejects.toThrowError(EmptyRepoError);
    // 契约：404 单次短退避重试吸收新建仓最终一致窗口后仍 404 → 终态；
    // 绝不烧满全部重试预算（扫描型 miss 配额保护）
    expect(callCount).toBe(2);
  });

  it('absorbs a transient 404 on freshly-created repo and succeeds on retry', async () => {
    const fetcher = new Fetcher('owner', 'fresh-repo', 'main');
    let callCount = 0;
    vi.spyOn(fetcher as any, 'gh').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 404, statusText: 'Not Found' };
      }
      return { ok: true, status: 200, json: async () => ({ tree: [{ path: 'README.md', type: 'blob' }] }) };
    });

    const tree = await fetcher.getRepoTree(3);
    expect((tree as any[]).length).toBeGreaterThan(0);
    expect(callCount).toBe(2);
  });

  it('getRawContent properly encodes filePath with special characters and slashes', async () => {
    const fetcher = new Fetcher('owner', 'repo', 'feature/branch');
    let requestedUrl = '';
    vi.spyOn(fetcher as any, 'gh').mockImplementation(async (url: string) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        text: async () => '# Document Content',
      };
    });

    const res = await fetcher.getRawContent('docs/file with spaces & #?%.md', 'v1.0/alpha#1');
    expect(res).toBe('# Document Content');
    expect(requestedUrl).toContain('v1.0/alpha%231');
    expect(requestedUrl).toContain('docs/file%20with%20spaces%20%26%20%23%3F%25.md');
  });
});
