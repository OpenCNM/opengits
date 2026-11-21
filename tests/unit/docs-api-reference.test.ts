import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadDocPageData } from '@/lib/docs/docs-page-loader';
import { prisma } from '@/lib/db';
import * as repoResolver from '@/lib/repository-resolver';
import * as docsFetch from '@/lib/docs-fetch';
import * as outlineReader from '@/lib/outline-reader';

vi.mock('@/lib/db', () => ({
  prisma: {
    importUpdateRun: { findMany: vi.fn().mockResolvedValue([]) },
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

describe('OpenAPI 1:1 API Reference Zero-Materialization Projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('projects virtual api-reference doc when repo has openApiUrl metadata and slug is api-reference', async () => {
    const mockRepo = {
      id: 'repo-with-openapi',
      owner: 'web-docs',
      repo: 'petstore-api',
      isPublic: true,
      branch: 'main',
      edition: null,
      relayEnabled: false,
      navTree: [],
      repoProfile: {
        sourceType: 'web',
        hasOpenApi: true,
        openApiVersion: '3.0.3',
        openApiTitle: 'Swagger Petstore',
        openApiUrl: 'https://petstore.swagger.io/v2/swagger.json',
      },
    };

    vi.mocked(repoResolver.resolveRepository).mockResolvedValue({
      repository: mockRepo as any,
      isOwner: false,
    });
    vi.mocked(docsFetch.findVisibleDoc).mockResolvedValue(null);
    vi.mocked(outlineReader.getActiveOutline).mockResolvedValue(null);

    const result = await loadDocPageData({
      owner: 'web-docs',
      repo: 'petstore-api',
      slug: ['api-reference'],
      userId: 'user-reader-1',
    });

    expect(result).not.toBeNull();
    if (result && 'doc' in result) {
      expect(result.doc.title).toBe('Swagger Petstore');
      expect(result.doc.path).toBe('api-reference.md');
      expect(result.relativePath).toBe('api-reference.md');
      expect(result.doc.status).toBe('PROCESSED');
      expect((result.doc as any).isVirtual).toBe(true);

      // F4 核心不变量：虚拟文档严格短路，严禁写入 userReadingProgress
      expect(prisma.userReadingProgress.upsert).not.toHaveBeenCalled();
    } else {
      expect.fail('Expected result to contain doc, but got redirect or null');
    }
  });

  it('projects virtual api doc when slug is api', async () => {
    const mockRepo = {
      id: 'repo-with-openapi-2',
      owner: 'web-docs',
      repo: 'eve-agent-api',
      isPublic: true,
      branch: 'main',
      edition: null,
      relayEnabled: false,
      navTree: [],
      repoProfile: {
        sourceType: 'web',
        hasOpenApi: true,
        openApiVersion: '3.1.0',
        openApiTitle: 'Eve Agent Platform API',
        openApiUrl: 'https://eve.dev/openapi.json',
      },
    };

    vi.mocked(repoResolver.resolveRepository).mockResolvedValue({
      repository: mockRepo as any,
      isOwner: false,
    });
    vi.mocked(docsFetch.findVisibleDoc).mockResolvedValue(null);
    vi.mocked(outlineReader.getActiveOutline).mockResolvedValue(null);

    const result = await loadDocPageData({
      owner: 'web-docs',
      repo: 'eve-agent-api',
      slug: ['api'],
    });

    expect(result).not.toBeNull();
    if (result && 'doc' in result) {
      expect(result.doc.title).toBe('Eve Agent Platform API');
      expect(result.doc.path).toBe('api-reference.md');
      expect((result.doc as any).isVirtual).toBe(true);
    } else {
      expect.fail('Expected result to contain doc, but got redirect or null');
    }
  });

  it('does not project virtual api doc when hasOpenApi is absent in repoProfile', async () => {
    const mockRepo = {
      id: 'repo-without-openapi',
      owner: 'web-docs',
      repo: 'plain-docs',
      isPublic: true,
      branch: 'main',
      edition: null,
      relayEnabled: false,
      navTree: [],
      repoProfile: {
        sourceType: 'web',
      },
    };

    vi.mocked(repoResolver.resolveRepository).mockResolvedValue({
      repository: mockRepo as any,
      isOwner: false,
    });
    vi.mocked(docsFetch.findVisibleDoc).mockResolvedValue(null);
    vi.mocked(outlineReader.getActiveOutline).mockResolvedValue(null);

    const result = await loadDocPageData({
      owner: 'web-docs',
      repo: 'plain-docs',
      slug: ['api-reference'],
    });

    // Should return not-found rather than synthesizing a false API reference
    expect(result).toEqual({ type: 'not-found' });
  });
});
