import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadDocPageData, clearPublicDocPageCacheForTest } from '@/lib/docs/docs-page-loader';
import { prisma } from '@/lib/db';
import * as repoResolver from '@/lib/repository-resolver';
import * as docsFetch from '@/lib/docs-fetch';
import * as outlineReader from '@/lib/outline-reader';

vi.mock('@/lib/db', () => ({
  prisma: {
    importUpdateRun: { findMany: vi.fn() },
    document: { count: vi.fn(), findFirst: vi.fn() },
    repository: { findUnique: vi.fn() },
    userReadingProgress: { findUnique: vi.fn(), upsert: vi.fn() },
    chapterUpdateJob: { findFirst: vi.fn().mockResolvedValue(null) },
    chapterVersion: { findMany: vi.fn().mockResolvedValue([]) },
    chapterVersionVote: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('@/lib/repository-resolver', () => ({
  resolveRepository: vi.fn(),
  findPublicGroupRow: vi.fn(),
  isWebDocRepository: vi.fn(() => true),
}));

vi.mock('@/lib/docs-fetch', () => ({
  findVisibleDoc: vi.fn(),
}));

vi.mock('@/lib/outline-reader', () => ({
  getActiveOutline: vi.fn(),
  resolveDocPathFromOutline: vi.fn(),
  allChaptersInTeachingOrder: vi.fn(() => []),
  outlineNodeUrl: vi.fn((owner: string, repo: string, docPath: string | null) => {
    if (!docPath) return '';
    const clean = docPath.replace(/\.mdx?$/i, '');
    if (clean.toLowerCase() === 'index' || clean.toLowerCase() === 'readme') {
      return `/docs/${owner}/${repo}`;
    }
    return `/docs/${owner}/${repo}/${clean}`;
  }),
  firstNavigableNode: vi.fn(),
}));

vi.mock('@/lib/state/chapter-version-projector', () => ({
  resolveEffectiveChapterVersion: vi.fn(() => ({
    activeVersion: null,
    sanitizedVersions: [],
    hasFallback: false,
  })),
}));

vi.mock('@/lib/docs/web-outline-projection', () => ({
  getWebL1OutlineProjection: vi.fn().mockResolvedValue(null),
  getWebL1OutlineProjectionById: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/repository-maintainer', () => ({
  resolveMaintainerUserId: vi.fn().mockResolvedValue(null),
}));

describe('Docs Root Index Resolution (ERR_TOO_MANY_REDIRECTS 根治测试)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPublicDocPageCacheForTest();
  });

  it('WebDoc 根文档为 index.md 时，slug=undefined 正常返回 doc 而不是循环重定向', async () => {
    const mockRepo = {
      id: 'repo-webdoc',
      owner: 'web-docs',
      repo: 'eve-dev',
      isPublic: true,
      branch: 'main',
    };

    vi.mocked(repoResolver.resolveRepository).mockResolvedValue({
      repository: mockRepo as any,
    });

    vi.mocked(outlineReader.getActiveOutline).mockResolvedValue({
      outlineId: 'o-1',
      version: 1,
      mode: 'tutorial',
      parts: [],
      chapters: [
        {
          id: 'c-1',
          title: 'Home',
          teachingOrder: 1,
          nodes: [
            { id: 'n-1', title: 'Home', nodeType: 'doc', docPath: 'index.md', docStatus: 'PROCESSED' },
          ],
        },
      ],
    } as any);

    vi.mocked(outlineReader.resolveDocPathFromOutline).mockReturnValue('index.md');

    // findVisibleDoc 命中 index.md
    vi.mocked(docsFetch.findVisibleDoc).mockImplementation(async (_repoWhere, candidates) => {
      if (candidates.includes('index.md')) {
        return {
          id: 'doc-index',
          repositoryId: 'repo-webdoc',
          path: 'index.md',
          title: 'Build production AI agents',
          content: '# Build production AI agents',
        } as any;
      }
      return null;
    });

    vi.mocked(prisma.importUpdateRun.findMany).mockResolvedValue([]);
    vi.mocked(prisma.document.count).mockResolvedValue(0);

    const result = await loadDocPageData({
      owner: 'web-docs',
      repo: 'eve-dev',
      slug: undefined, // Next.js App Router 访问 /docs/web-docs/eve-dev 或 /index 时传入 undefined
    });

    expect(result.type).toBe('doc');
    if (result.type === 'doc') {
      expect(result.doc.path).toBe('index.md');
      expect(result.doc.title).toBe('Build production AI agents');
    }
  });

  it('即使文档暂未命中，根路径也绝不重定向至自身 /docs/owner/repo 或 /index', async () => {
    const mockRepo = {
      id: 'repo-webdoc',
      owner: 'web-docs',
      repo: 'eve-dev',
      isPublic: true,
      branch: 'main',
    };

    vi.mocked(repoResolver.resolveRepository).mockResolvedValue({
      repository: mockRepo as any,
    });

    vi.mocked(outlineReader.getActiveOutline).mockResolvedValue({
      outlineId: 'o-1',
      version: 1,
      mode: 'tutorial',
      parts: [],
      chapters: [],
    } as any);

    vi.mocked(docsFetch.findVisibleDoc).mockResolvedValue(null);
    vi.mocked(outlineReader.firstNavigableNode).mockReturnValue({
      id: 'n-1',
      docPath: 'index.md',
    } as any);

    const result = await loadDocPageData({
      owner: 'web-docs',
      repo: 'eve-dev',
      slug: undefined,
    });

    // 严禁返回循环重定向，安全降级 not-found
    expect(result.type).not.toBe('redirect');
    expect(result.type).toBe('not-found');
  });

  it('显式请求 /index 或 /README 时，执行 canonical 301 规范重定向到目录根路径', async () => {
    const mockRepo = {
      id: 'repo-webdoc',
      owner: 'web-docs',
      repo: 'eve-dev',
      isPublic: true,
      branch: 'main',
    };

    vi.mocked(repoResolver.resolveRepository).mockResolvedValue({
      repository: mockRepo as any,
    });

    // 1. 裸 /index 重定向到仓根
    const resultIndex = await loadDocPageData({
      owner: 'web-docs',
      repo: 'eve-dev',
      slug: ['index'],
    });
    expect(resultIndex).toEqual({
      type: 'redirect',
      url: '/docs/web-docs/eve-dev',
    });

    // 2. 大写 /README 重定向到仓根
    const resultReadme = await loadDocPageData({
      owner: 'web-docs',
      repo: 'eve-dev',
      slug: ['README'],
    });
    expect(resultReadme).toEqual({
      type: 'redirect',
      url: '/docs/web-docs/eve-dev',
    });

    // 3. 嵌套 /sub/index 重定向到父目录 /sub
    const resultSubIndex = await loadDocPageData({
      owner: 'web-docs',
      repo: 'eve-dev',
      slug: ['sub', 'index'],
    });
    expect(resultSubIndex).toEqual({
      type: 'redirect',
      url: '/docs/web-docs/eve-dev/sub',
    });
  });
});
