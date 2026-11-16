import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCallSidecar = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => mockCallSidecar(...args),
}));

const mockGetL1 = vi.fn();
vi.mock('@/lib/docs/web-outline-projection', () => ({
  getWebL1OutlineProjectionById: (...args: unknown[]) => mockGetL1(...args),
}));

vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
}));

describe('outline-reader (Go sidecar offloaded & helpers)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetL1.mockResolvedValue(null);
  });

  it('L1 projection 命中时直接返回，不调用 sidecar', async () => {
    const fakeL1Outline = {
      outlineId: 'outline-l1',
      version: 1,
      mode: 'tutorial',
      parts: [],
      chapters: [],
    };
    mockGetL1.mockResolvedValue({ outline: fakeL1Outline });

    const { getActiveOutline } = await import('@/lib/outline-reader');
    const res = await getActiveOutline('repo-l1');

    expect(res).toEqual(fakeL1Outline);
    expect(mockCallSidecar).not.toHaveBeenCalled();
  });

  it('L1 未命中时调用 sidecar /v1/outline/active 获取大纲', async () => {
    const fakeSidecarOutline = {
      outlineId: 'outline-go',
      version: 2,
      mode: 'tutorial',
      parts: [
        {
          id: 'part-1',
          title: '基础篇',
          summary: '入门',
          teachingOrder: 1,
          chapters: [
            {
              id: 'ch-1',
              title: '安装',
              summary: null,
              chapterType: 'doc',
              moduleName: null,
              teachingOrder: 1,
              nodes: [
                {
                  id: 'node-1',
                  title: '快速上手',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'doc-1',
                  docPath: 'docs/quickstart.md',
                  docStatus: 'PROCESSED',
                },
                {
                  id: 'node-2',
                  title: '配置项',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'doc-2',
                  docPath: 'docs/config.md',
                  docStatus: 'PROCESSED',
                },
              ],
            },
          ],
        },
      ],
      chapters: [],
    };
    mockCallSidecar.mockResolvedValue({ ok: true, outline: fakeSidecarOutline });

    const { getActiveOutline, firstNavigableNode, adjacentNavigableNodes, resolveDocPathFromOutline, outlineNodeUrl } =
      await import('@/lib/outline-reader');

    const res = await getActiveOutline('repo-go');
    expect(res).toEqual(fakeSidecarOutline);
    expect(mockCallSidecar).toHaveBeenCalledWith(
      '/v1/outline/active',
      { repositoryId: 'repo-go' },
      expect.objectContaining({ label: 'outline-reader /v1/outline/active' })
    );

    // 验证辅助函数行为
    const first = firstNavigableNode(res!);
    expect(first?.id).toBe('node-1');

    const adj = adjacentNavigableNodes(res!, 'docs/quickstart.md');
    expect(adj.prev).toBeNull();
    expect(adj.next?.docPath).toBe('docs/config.md');

    const resolved = resolveDocPathFromOutline(res!, 'docs/config');
    expect(resolved).toBe('docs/config.md');

    const url = outlineNodeUrl('alice', 'repo', 'docs/quickstart.md');
    expect(url).toBe('/docs/alice/repo/docs/quickstart');

    // 根主文档（index / README）收敛至仓根路径，规避 Next.js App Router /index 循环重定向
    expect(outlineNodeUrl('alice', 'repo', 'index.md')).toBe('/docs/alice/repo');
    expect(outlineNodeUrl('alice', 'repo', 'README.md')).toBe('/docs/alice/repo');
    expect(outlineNodeUrl('alice', 'repo', 'index.mdx')).toBe('/docs/alice/repo');
  });

  it('resolveDocPathFromOutline 与 outlineNodeUrl 兼容根文档（index / README）反查与规范化', async () => {
    const { resolveDocPathFromOutline, outlineNodeUrl } = await import('@/lib/outline-reader');

    const fakeOutline: any = {
      outlineId: 'o-root',
      version: 1,
      mode: 'tutorial',
      parts: [],
      chapters: [
        {
          id: 'c-root',
          title: 'Overview',
          teachingOrder: 1,
          nodes: [
            { id: 'n-idx', title: 'Home', nodeType: 'doc', docPath: 'index.md', docStatus: 'PROCESSED' },
            { id: 'n-sub', title: 'Sub', nodeType: 'doc', docPath: 'guide/intro.md', docStatus: 'PROCESSED' },
          ],
        },
      ],
    };

    // 根路径 '' 以及 'index' 均能正向反查到 index.md
    expect(resolveDocPathFromOutline(fakeOutline, '')).toBe('index.md');
    expect(resolveDocPathFromOutline(fakeOutline, 'index')).toBe('index.md');
    expect(resolveDocPathFromOutline(fakeOutline, 'guide/intro')).toBe('guide/intro.md');

    // outlineNodeUrl 对根 index.md 返回干净仓根，子路径保持正常 slug
    expect(outlineNodeUrl('web-docs', 'eve-dev', 'index.md')).toBe('/docs/web-docs/eve-dev');
    expect(outlineNodeUrl('web-docs', 'eve-dev', 'guide/intro.md')).toBe('/docs/web-docs/eve-dev/guide/intro');
  });

  it('sidecar 返回空大纲时返回 null', async () => {
    mockCallSidecar.mockResolvedValue({ ok: true, outline: null });

    const { getActiveOutline } = await import('@/lib/outline-reader');
    const res = await getActiveOutline('repo-empty');

    expect(res).toBeNull();
  });

  it('sidecar 抛错异常时安全兜底返回 null，不向外抛异常', async () => {
    mockCallSidecar.mockRejectedValue(new Error('sidecar timeout'));

    const { getActiveOutline } = await import('@/lib/outline-reader');
    const res = await getActiveOutline('repo-err');

    expect(res).toBeNull();
  });
});
