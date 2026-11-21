import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  loadDocPageData,
  clearPublicDocPageCacheForTest,
  clearRepoDocPageMetaCacheForTest,
} from '@/lib/docs/docs-page-loader';
import { ChapterShareButton } from '@/components/docs/ChapterShareButton';
import * as repoResolver from '@/lib/repository-resolver';
import * as docsFetch from '@/lib/docs-fetch';
import * as outlineProjection from '@/lib/docs/web-outline-projection';

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
  isWebDocRepository: vi.fn(() => false),
}));

vi.mock('@/lib/docs-fetch', () => ({
  findVisibleDoc: vi.fn(),
}));

vi.mock('@/lib/outline-reader', () => ({
  getActiveOutline: vi.fn().mockResolvedValue(null),
  resolveDocPathFromOutline: vi.fn(),
  allChaptersInTeachingOrder: vi.fn(() => []),
  outlineNodeUrl: vi.fn(() => ''),
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

describe('ChapterShareButton visibility', () => {
  it('hides share button when tutorial is private (isPublic=false)', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChapterShareButton, { title: 'Secret Chapter', isPublic: false })
    );
    expect(html).toBe('');
  });

  it('renders share button when tutorial is public (isPublic=true)', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChapterShareButton, { title: 'Public Chapter', isPublic: true })
    );
    expect(html).toContain('<button');
  });
});

describe('Public Shared Chapter Fast-Path (0-DB / 0-Sidecar hit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPublicDocPageCacheForTest();
    clearRepoDocPageMetaCacheForTest();
  });

  it('reuses L1 projection and caches resolved public chapter for anonymous guests', async () => {
    const mockRepo = {
      id: 'repo-pub-1',
      owner: 'acme',
      repo: 'guide',
      branch: 'main',
      edition: '',
      isPublic: true,
      relayEnabled: false,
      repoProfile: {},
      transcriptionModels: [],
      transcriptionTokens: 0,
      helpfulCount: 0,
      navTree: [],
    };

    vi.mocked(outlineProjection.getWebL1OutlineProjection).mockResolvedValue({
      repositoryId: 'repo-pub-1',
      owner: 'acme',
      repo: 'guide',
      branch: 'main',
      edition: '',
      gitSha: 'abc123',
      outlineVersion: 1,
      outline: { outlineId: 'ol-1', version: 1, mode: 'tutorial', parts: [], chapters: [] },
      navTree: [],
      docPaths: ['intro.md'],
      teachingDocPaths: ['intro.md'],
      editionOptions: [],
      repoSnapshot: mockRepo,
      builtAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    vi.mocked(docsFetch.findVisibleDoc).mockResolvedValue({
      id: 'doc-1',
      repositoryId: 'repo-pub-1',
      path: 'intro.md',
      title: 'Intro',
      content: '# Hello Guest',
      contentId: 'cid-1',
      ownerUserId: null,
      status: 'PROCESSED',
      generationLevel: 1,
      repository: mockRepo,
    } as any);

    const first = await loadDocPageData({
      owner: 'acme',
      repo: 'guide',
      slug: ['intro'],
    });
    expect(first.type).toBe('doc');
    expect(repoResolver.resolveRepository).not.toHaveBeenCalled();
    expect(docsFetch.findVisibleDoc).toHaveBeenCalledTimes(1);

    const second = await loadDocPageData({
      owner: 'acme',
      repo: 'guide',
      slug: ['intro'],
    });
    expect(second.type).toBe('doc');
    // Second guest hit is served entirely from publicDocPageCache (0 additional DB calls)
    expect(docsFetch.findVisibleDoc).toHaveBeenCalledTimes(1);
  });

  it('does not cache uninitialized chapters with empty content', async () => {
    const mockRepo = {
      id: 'repo-pub-2',
      owner: 'acme',
      repo: 'wip',
      branch: 'main',
      edition: '',
      isPublic: true,
      relayEnabled: false,
      repoProfile: {},
      transcriptionModels: [],
      transcriptionTokens: 0,
      helpfulCount: 0,
      navTree: [],
    };

    vi.mocked(outlineProjection.getWebL1OutlineProjection).mockResolvedValue({
      repositoryId: 'repo-pub-2',
      owner: 'acme',
      repo: 'wip',
      branch: 'main',
      edition: '',
      gitSha: 'abc123',
      outlineVersion: 1,
      outline: { outlineId: '', version: 1, mode: 'tutorial', parts: [], chapters: [] },
      navTree: [],
      docPaths: ['ch1.md'],
      teachingDocPaths: ['ch1.md'],
      editionOptions: [],
      repoSnapshot: mockRepo,
      builtAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    vi.mocked(docsFetch.findVisibleDoc).mockResolvedValue({
      id: 'doc-2',
      repositoryId: 'repo-pub-2',
      path: 'ch1.md',
      title: 'Chapter 1',
      content: '',
      contentId: null,
      ownerUserId: null,
      status: 'UNPROCESSED',
      generationLevel: 0,
      repository: mockRepo,
    } as any);

    await loadDocPageData({ owner: 'acme', repo: 'wip', slug: ['ch1'] });
    await loadDocPageData({ owner: 'acme', repo: 'wip', slug: ['ch1'] });
    expect(docsFetch.findVisibleDoc).toHaveBeenCalledTimes(2);
  });
});
