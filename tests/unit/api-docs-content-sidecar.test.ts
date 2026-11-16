import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const callSidecarMock = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

const cachedDefaultBranchRepositoryMock = vi.fn();
vi.mock('@/lib/mcp/repo-resolve-cache', () => ({
  cachedDefaultBranchRepository: (...args: unknown[]) => cachedDefaultBranchRepositoryMock(...args),
}));

const getSessionHelperMock = vi.fn();
vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: (...args: unknown[]) => getSessionHelperMock(...args),
}));

const verifyRepoAccessDirectMock = vi.fn();
vi.mock('@/lib/auth-utils', () => ({
  verifyRepoAccessDirect: (...args: unknown[]) => verifyRepoAccessDirectMock(...args),
}));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  clientIpFromRequest: () => '127.0.0.1',
}));

describe('GET /api/docs-content/[owner]/[repo]/[...slug] (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimitMock.mockResolvedValue(true);
  });

  async function callDocsContent(
    owner: string,
    repo: string,
    slug?: string[],
    headers?: Record<string, string>
  ) {
    const { GET } = await import('@/app/api/docs-content/[owner]/[repo]/[...slug]/route');
    const req = new NextRequest(`http://localhost/api/docs-content/${owner}/${repo}/${slug?.join('/') ?? ''}`, {
      headers,
    });
    return GET(req, {
      params: Promise.resolve({ owner, repo, slug }),
    });
  }

  it('仓库不存在时返回 404', async () => {
    cachedDefaultBranchRepositoryMock.mockResolvedValue(null);
    const res = await callDocsContent('octocat', 'hello-world', ['intro']);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Repository not found');
  });

  it('slug 为空时返回 400', async () => {
    cachedDefaultBranchRepositoryMock.mockResolvedValue({
      id: 'repo-1',
      owner: 'octocat',
      repo: 'hello-world',
      isPublic: true,
    });
    const res = await callDocsContent('octocat', 'hello-world', []);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Document path required');
  });

  it('公开仓通过 sidecar 成功拉取内容并返回 200 text/markdown', async () => {
    cachedDefaultBranchRepositoryMock.mockResolvedValue({
      id: 'repo-1',
      owner: 'octocat',
      repo: 'hello-world',
      isPublic: true,
    });

    callSidecarMock.mockResolvedValueOnce({
      ok: true,
      document: {
        id: 'doc-1',
        path: 'guide/intro.md',
        title: 'Guide',
        status: 'PROCESSED',
        content: '# Getting Started\nWelcome!',
      },
    });

    const res = await callDocsContent('octocat', 'hello-world', ['guide', 'intro']);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(await res.text()).toBe('# Getting Started\nWelcome!');

    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/documents/content',
      {
        repositoryId: 'repo-1',
        candidatePaths: ['guide/intro.md', 'guide/intro.mdx', 'guide/intro/README.md'],
        userId: undefined,
      },
      expect.objectContaining({ label: 'docs-content /v1/documents/content' })
    );
  });

  it('文档不存在或内容为空时返回 404', async () => {
    cachedDefaultBranchRepositoryMock.mockResolvedValue({
      id: 'repo-1',
      owner: 'octocat',
      repo: 'hello-world',
      isPublic: true,
    });

    callSidecarMock.mockResolvedValueOnce({
      ok: false,
      code: 'DOCUMENT_NOT_FOUND',
    });

    const res = await callDocsContent('octocat', 'hello-world', ['missing']);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Document content not found or processing');
  });

  it('私有仓未授权时返回 403', async () => {
    cachedDefaultBranchRepositoryMock.mockResolvedValue({
      id: 'repo-2',
      owner: 'octocat',
      repo: 'private-repo',
      isPublic: false,
    });
    getSessionHelperMock.mockResolvedValue({ user: { id: 'usr-unauthorized' } });
    verifyRepoAccessDirectMock.mockResolvedValue(false);

    const res = await callDocsContent('octocat', 'private-repo', ['secret']);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Forbidden: Repository is private');
    expect(callSidecarMock).not.toHaveBeenCalled();
  });

  it('OPTIONS 预检请求返回 204', async () => {
    const { OPTIONS } = await import('@/app/api/docs-content/[owner]/[repo]/[...slug]/route');
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('GET, OPTIONS');
  });
});
