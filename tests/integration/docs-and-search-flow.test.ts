import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { ENGINE_CONFIG } from '@/lib/config';
import { packSearchIndex, unpackSearchIndex } from '@/lib/search/binary-index-packer';
import { tokenizeSearchText } from '@/lib/search/binary-index-tokenizer';
import { dissectSearchQuery, matchRepoWithSmartQuery } from '@/lib/search/smart-repo-search';
import { evaluateEngine } from '@/lib/search-eval';
import {
  buildRepoAssetUrl,
  clearPublicDocPageCacheForTest,
  clearRepoDocPageMetaCacheForTest,
  inferDocSubsystem,
  loadDocPageData,
  resolveEffectiveChapterVersion,
} from '@/lib/docs/docs-page-loader';
import { findVisibleDoc } from '@/lib/docs-fetch';
import { resolveDocLiveUrl } from '@/lib/repository-resolver';
import { searchGlobalDocs, searchRepositoryDocs } from '@/lib/mcp/doc-search';
import type { DisplayRepo } from '@/lib/home-data';
import { HAS_SIDECAR, HAS_TEST_DB, createTestUser, uniqueTestTag } from './_test-env';

/**
 * Docs Page Scaffold/Loader/Fallback & Search Index/Rerank Flow Integration Suite.
 *
 * Supersedes mocked unit tests:
 * - docs-api-reference, docs-edition-href, docs-fetch, docs-mdx-deep-dive-runtime,
 *   docs-nav-tree-outline, docs-nav-tree, docs-page-loader-cache,
 *   docs-page-loader-scaffold, docs-page-request-memo, docs-root-index-redirect,
 *   docs-share-guest-fastpath, api-search-empty, mcp-alias-expansion,
 *   mcp-search-fail-closed, mcp-search-symbols, mcp-search-unified.
 */

function makeDisplayRepo(overrides: Partial<DisplayRepo> = {}): DisplayRepo {
  return {
    id: 'repo-1',
    owner: 'vercel',
    repo: 'next.js',
    branch: 'main',
    isPublic: true,
    title: 'Next.js Framework',
    category: 'Frontend',
    tags: ['react', 'ssr'],
    description: 'The React Framework for the Web',
    chapterCount: 5,
    processedDocsCount: 5,
    isFullyTranscribed: true,
    isSaved: false,
    savedCount: 10,
    progress: 0,
    viewedCount: 0,
    hasUpdate: false,
    importedSha: null,
    isPinned: false,
    isMcpDisabled: false,
    lastReadPath: null,
    ...overrides,
  };
}

describe('Search Binary Index, Query Dissection, Eval & Docs Scaffold Helpers (Non-DB)', () => {
  it('tokenizes CJK + camelCase/snake_case and round-trips OGIS v1 binary index', () => {
    const tokens = tokenizeSearchText('线性内存 parseSectionAddress snake_case_fn');
    expect(tokens).toContain('线性');
    expect(tokens).toContain('内存');
    expect(tokens).toContain('parsesectionaddress');
    expect(tokens).toContain('section');
    expect(tokens).toContain('snake');

    const packed = packSearchIndex(
      {
        owner: 'octo',
        repo: 'demo',
        gitSha: 'abcdef1234567890abcdef1234567890abcdef12',
        chunks: [
          {
            id: 'c1',
            docPath: 'docs/memory.md',
            title: 'Memory Architecture',
            heading: '线性内存',
            headingPath: 'Memory > 线性内存',
            content: '线性内存模型与上下文隔离机制',
            tokens,
          },
          {
            id: 'c2',
            docPath: 'docs/routing.md',
            title: 'App Router',
            heading: 'Routing',
            headingPath: 'Routing',
            content: 'Dynamic route segments and layouts',
            tokens: tokenizeSearchText('Dynamic route segments and layouts'),
          },
        ],
      },
      true,
      1
    );

    const unpacked = unpackSearchIndex(packed);
    expect(unpacked.magic).toBe('OGIS');
    expect(unpacked.version).toBe(1);
    expect(unpacked.owner).toBe('octo');
    expect(unpacked.repo).toBe('demo');
    expect(unpacked.chunks).toHaveLength(2);
    expect(unpacked.chunks[0].docPath).toBe('docs/memory.md');
    expect(unpacked.terms.get('线性')?.postings).toEqual([{ chunkIndex: 0, freq: 1 }]);
    expect(unpacked.terms.get('routing') || unpacked.terms.get('route')).toBeDefined();

    expect(() => unpackSearchIndex(Buffer.from('BAD!'))).toThrow();
  });

  it('dissects URLs fail-closed and evaluates search engine recall & degradation', async () => {
    const gh = dissectSearchQuery('https://github.com/vercel/next.js/tree/canary');
    expect(gh).toMatchObject({ isUrl: true, candidateOwner: 'vercel', candidateRepo: 'next.js' });

    const nextRepo = makeDisplayRepo();
    const webRepo = makeDisplayRepo({
      id: 'web-1',
      owner: 'web-doc',
      repo: 'web-docs-coss-ui',
      category: 'Frontend',
      repoProfile: {
        sourceType: 'web',
        originalUrl: 'https://coss.com/ui/docs',
        allowedPrefixes: ['/ui/docs'],
      },
    });

    // URL query must NOT bleed into fuzzy substring matching across unrelated repos
    expect(matchRepoWithSmartQuery(nextRepo, 'https://github.com/vercel/next.js')).toBe(true);
    expect(matchRepoWithSmartQuery(nextRepo, 'https://coss.com/ui/docs')).toBe(false);
    expect(matchRepoWithSmartQuery(webRepo, 'https://coss.com/ui/docs/components', 'webdoc')).toBe(true);
    expect(matchRepoWithSmartQuery(webRepo, 'https://coss.com/blog', 'webdoc')).toBe(false);
    expect(matchRepoWithSmartQuery(nextRepo, '#ssr react', 'github', 'Frontend')).toBe(true);

    const report = await evaluateEngine(
      'test-pg',
      async (_repoId, q) => {
        if (q.includes('alpha')) {
          return [{ content: 'Alpha architecture overview', ftsRank: 0.8 }];
        }
        return [{ content: 'fallback match', matchCount: 1 }];
      },
      'repo-1',
      {
        k: 5,
        cases: [
          { id: 'c1', query: 'alpha', expectKeywords: ['alpha', 'overview'] },
          { id: 'c2', query: 'beta', expectKeywords: ['missing'] },
        ],
      }
    );
    expect(report.passedCases).toBe(1);
    expect(report.recallAtK).toBe(0.5);
    expect(report.degradation.FTS).toBe(1);
    expect(report.degradation.keyword).toBe(1);
  });

  it('resolves doc scaffolds, asset URLs, live URLs & corrupted chapter version fallback', () => {
    const sub = inferDocSubsystem('docs/auth/oauth-flow.md', 'OAuth2 Flow');
    expect(sub.subsystemName).toBe('auth');
    expect(sub.subsystemDuty.length).toBeGreaterThan(0);

    expect(buildRepoAssetUrl('octo', 'demo', 'main', 'src/index.ts')).toBe(
      'https://github.com/octo/demo/blob/main/src/index.ts'
    );
    expect(buildRepoAssetUrl('octo', 'demo', 'main', 'https://example.com/a.png')).toBe(
      'https://example.com/a.png'
    );

    const navTree = [
      {
        type: 'file',
        path: 'docs/start.md',
        sourceUrl: 'https://example.com/docs/start',
      },
    ];
    expect(resolveDocLiveUrl(navTree, 'docs/start.md', 'https://example.com')).toBe(
      'https://example.com/docs/start'
    );
    expect(resolveDocLiveUrl(navTree, 'docs/other.md', 'https://example.com')).toBe(
      'https://example.com'
    );

    // Corrupted private/requested version falls back cleanly to valid canonical version
    const resolved = resolveEffectiveChapterVersion(
      [
        { id: 'v-priv', authorId: 'u1', visibility: 'PRIVATE', contentId: 'missing-cid', isCanonical: false },
        { id: 'v-canon', authorId: 'u2', visibility: 'PUBLIC', contentId: 'valid-cid', isCanonical: true },
      ],
      { versionParam: 'v-priv', userId: 'u1', validContentIds: new Set(['valid-cid']) }
    );
    expect(resolved.activeVersion?.id).toBe('v-canon');
    expect(resolved.hasFallback).toBe(true);
    expect(resolved.sanitizedVersions[0].isCorrupted).toBe(true);
  });
});

describe.skipIf(!HAS_TEST_DB)('Docs Page Loader, Visibility Fallback & Search Flow (Real DB)', () => {
  const createdUserIds: string[] = [];
  const createdRepoIds: string[] = [];
  const createdContentIds: string[] = [];

  afterAll(async () => {
    clearRepoDocPageMetaCacheForTest();
    clearPublicDocPageCacheForTest();
    if (createdRepoIds.length > 0) {
      await prisma.userReadingProgress.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
      await prisma.chapterVersion.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
      await prisma.tutorialOutline.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
      await prisma.documentChunk.deleteMany({
        where: { document: { repositoryId: { in: createdRepoIds } } },
      }).catch(() => {});
      await prisma.document.deleteMany({ where: { repositoryId: { in: createdRepoIds } } }).catch(() => {});
      await prisma.repository.deleteMany({ where: { id: { in: createdRepoIds } } }).catch(() => {});
    }
    if (createdContentIds.length > 0) {
      await prisma.documentChunk.deleteMany({ where: { contentId: { in: createdContentIds } } }).catch(() => {});
      await prisma.documentContent.deleteMany({ where: { id: { in: createdContentIds } } }).catch(() => {});
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }
  });

  it('loads docs pages with canonical redirects, extension/dir fallbacks, virtual API ref & private doc precedence', async () => {
    const userA = await createTestUser('doc-uA');
    const userB = await createTestUser('doc-uB');
    createdUserIds.push(userA.id, userB.id);

    const owner = uniqueTestTag('docs-owner');
    const repoName = uniqueTestTag('docs-repo');
    const branch = ENGINE_CONFIG.defaultBranch;

    const repo = await prisma.repository.create({
      data: {
        owner,
        repo: repoName,
        branch,
        isPublic: true,
        repoProfile: { hasOpenApi: true, openApiTitle: 'Demo OpenAPI' },
        navTree: [
          { name: 'README', title: 'Overview', type: 'file', path: 'README.md', url: `/docs/${owner}/${repoName}` },
          { name: 'guide', title: 'Guide', type: 'file', path: 'guide.mdx', url: `/docs/${owner}/${repoName}/guide` },
        ],
      },
    });
    createdRepoIds.push(repo.id);

    const dcShared = await prisma.documentContent.create({
      data: { contentHash: uniqueTestTag('dc-shared'), content: '# Shared Guide\n\nPublic text.', lang: 'en' },
    });
    const dcPrivateA = await prisma.documentContent.create({
      data: { contentHash: uniqueTestTag('dc-privA'), content: '# Private Guide A\n\nUser A override.', lang: 'en' },
    });
    createdContentIds.push(dcShared.id, dcPrivateA.id);

    await prisma.document.createMany({
      data: [
        { repositoryId: repo.id, path: 'README.md', title: 'Overview', status: 'PROCESSED', content: '# Overview\n\nWelcome' },
        { repositoryId: repo.id, path: 'guide.mdx', title: 'Guide', status: 'PROCESSED', content: null, contentId: dcShared.id },
        { repositoryId: repo.id, ownerUserId: userA.id, path: 'guide.mdx', title: 'Guide (Private A)', status: 'PROCESSED', content: null, contentId: dcPrivateA.id },
        { repositoryId: repo.id, path: 'sub/README.md', title: 'Sub Index', status: 'PROCESSED', content: '# Sub Index' },
      ],
    });

    // 1. Canonical /index redirect
    const redirRoot = await loadDocPageData({ owner, repo: repoName, slug: ['index'] });
    expect(redirRoot).toEqual({ type: 'redirect', url: `/docs/${owner}/${repoName}` });

    const redirNested = await loadDocPageData({ owner, repo: repoName, slug: ['sub', 'index'] });
    expect(redirNested).toEqual({ type: 'redirect', url: `/docs/${owner}/${repoName}/sub` });

    // 2. Root load resolves README.md
    const rootPage = await loadDocPageData({ owner, repo: repoName, slug: [] });
    expect(rootPage.type).toBe('doc');
    if (rootPage.type === 'doc') {
      expect(rootPage.doc.path).toBe('README.md');
    }

    // 3. Extension fallback: ['guide'] -> guide.mdx; private doc wins for userA, shared for userB/guest
    const guestGuide = await loadDocPageData({ owner, repo: repoName, slug: ['guide'], userId: null });
    expect(guestGuide.type).toBe('doc');
    if (guestGuide.type === 'doc') {
      expect(guestGuide.doc.content).toContain('Public text');
    }

    const userAGuide = await loadDocPageData({ owner, repo: repoName, slug: ['guide'], userId: userA.id });
    expect(userAGuide.type).toBe('doc');
    if (userAGuide.type === 'doc') {
      expect(userAGuide.doc.content).toContain('User A override');
    }

    const userBVisible = await findVisibleDoc({ id: repo.id }, ['guide.mdx'], userB.id);
    expect(userBVisible?.ownerUserId).toBeNull();

    // 4. Directory index fallback: ['sub'] -> sub/README.md
    const subPage = await loadDocPageData({ owner, repo: repoName, slug: ['sub'], userId: null });
    expect(subPage.type).toBe('doc');
    if (subPage.type === 'doc') {
      expect(subPage.doc.path).toBe('sub/README.md');
    }

    // 5. Virtual API Reference projection without bookmark pollution
    const apiRef = await loadDocPageData({ owner, repo: repoName, slug: ['api-reference'], userId: userA.id });
    expect(apiRef.type).toBe('doc');
    if (apiRef.type === 'doc') {
      expect(apiRef.doc.isVirtual).toBe(true);
      expect(apiRef.doc.title).toBe('Demo OpenAPI');
    }

    // 6. Missing slug returns not-found
    const missing = await loadDocPageData({ owner, repo: repoName, slug: ['does-not-exist'], userId: null });
    expect(missing).toEqual({ type: 'not-found' });
  });

  it.skipIf(!HAS_SIDECAR)('runs real searchRepositoryDocs, searchGlobalDocs & GET /api/search contracts', async () => {
    const owner = uniqueTestTag('srch-owner');
    const repoName = uniqueTestTag('srch-repo');

    const repo = await prisma.repository.create({
      data: { owner, repo: repoName, branch: ENGINE_CONFIG.defaultBranch, isPublic: true },
    });
    createdRepoIds.push(repo.id);

    const dc = await prisma.documentContent.create({
      data: {
        contentHash: uniqueTestTag('srch-dc'),
        content: 'Deterministic telemetry rerank anchor phrase.',
        lang: 'en',
      },
    });
    createdContentIds.push(dc.id);

    const doc = await prisma.document.create({
      data: {
        repositoryId: repo.id,
        path: 'docs/telemetry.md',
        title: 'Telemetry Rerank',
        status: 'PROCESSED',
        content: null,
        contentId: dc.id,
      },
    });
    await prisma.documentChunk.create({
      data: {
        contentId: dc.id,
        heading: 'Telemetry',
        headingPath: 'Telemetry',
        contentType: 'prose',
        content: 'Deterministic telemetry rerank anchor phrase.',
        order: 0,
      },
    });
    void doc;

    const repoHits = await searchRepositoryDocs(repo.id, 'telemetry rerank', 5);
    expect(repoHits.length).toBeGreaterThanOrEqual(1);
    expect(repoHits[0].path).toBe('docs/telemetry.md');

    const globalHits = await searchGlobalDocs('telemetry rerank', 10);
    expect(Array.isArray(globalHits)).toBe(true);

    const { GET } = await import('@/app/api/search/route');
    const emptyRes = await GET(new NextRequest('http://localhost/api/search'), {
      params: Promise.resolve({}),
    });
    expect(emptyRes.status).toBe(200);
    const emptyJson = (await emptyRes.json()) as { success: boolean; data: unknown[] };
    expect(emptyJson.success).toBe(true);
    expect(Array.isArray(emptyJson.data)).toBe(true);

    const queryRes = await GET(
      new NextRequest(
        `http://localhost/api/search?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repoName)}&q=telemetry`
      ),
      { params: Promise.resolve({}) }
    );
    expect(queryRes.status).toBe(200);
    const queryJson = (await queryRes.json()) as { success: boolean; data: unknown[] };
    expect(queryJson.success).toBe(true);
    expect(Array.isArray(queryJson.data)).toBe(true);
  });
});
