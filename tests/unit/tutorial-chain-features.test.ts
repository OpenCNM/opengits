import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GenerationLevelBadge } from '@/components/docs/GenerationLevelBadge';
import { GENERATION_LEVEL } from '@/lib/constants';
import { PUBLIC_HOME_CACHE_TAG } from '@/lib/home/public-home-data';

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    document: {
      findFirst: vi.fn(),
    },
    importRecord: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: vi.fn(),
}));

vi.mock('@/lib/review/publish-fanout', () => ({
  notifyClientRevalidate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/docs/web-outline-projection', () => ({
  invalidateWebL1Projection: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

describe('GenerationLevelBadge', () => {
  it('renders correctly for each known generation level', () => {
    const levels = [
      GENERATION_LEVEL.ENHANCED,
      GENERATION_LEVEL.TRANSLATED,
      GENERATION_LEVEL.ORIGINAL,
      GENERATION_LEVEL.CODE_LESSON,
    ];

    for (const level of levels) {
      const html = renderToStaticMarkup(React.createElement(GenerationLevelBadge, { level }));
      expect(html).toContain('data-testid="generation-level-badge"');
      expect(html.length).toBeGreaterThan(20);
    }
  });

  it('renders null when level is null or undefined or unrecognized', () => {
    expect(renderToStaticMarkup(React.createElement(GenerationLevelBadge, { level: null }))).toBe('');
    expect(renderToStaticMarkup(React.createElement(GenerationLevelBadge, { level: undefined }))).toBe('');
    expect(renderToStaticMarkup(React.createElement(GenerationLevelBadge, { level: 'unknown_level' }))).toBe('');
  });
});

describe('Cache Invalidation Broadcast on Unpublish and Promote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('unpublishRepository broadcasts cache invalidation via notifyClientRevalidate', async () => {
    const { prisma } = await import('@/lib/db');
    const { callSidecar } = await import('@/lib/sidecar-client');
    const { notifyClientRevalidate } = await import('@/lib/review/publish-fanout');
    const { unpublishRepository } = await import('@/lib/review/unpublish-repository');

    vi.mocked(prisma.repository.findUnique).mockResolvedValue({
      id: 'repo-1',
      owner: 'testowner',
      repo: 'testrepo',
      edition: '',
      isPublic: true,
      reviewPipeline: {},
      unpublishCooldownUntil: null,
      unpublishRequestedAt: null,
    } as any);

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      role: 'ADMIN',
      tier: 'ENTERPRISE',
    } as any);

    vi.mocked(callSidecar).mockResolvedValue({
      ok: true,
      cancelledPendingGrantsCount: 0,
      detachedSavedReposCount: 0,
    });

    const res = await unpublishRepository('user-1', { repoId: 'repo-1' });

    expect(res.success).toBe(true);
    expect(notifyClientRevalidate).toHaveBeenCalledWith([PUBLIC_HOME_CACHE_TAG], ['repo-1']);
  });

  it('promoteEditionRepository broadcasts cache invalidation with both new and old repo ids', async () => {
    const { prisma } = await import('@/lib/db');
    const { callSidecar } = await import('@/lib/sidecar-client');
    const { notifyClientRevalidate } = await import('@/lib/review/publish-fanout');
    const { promoteEditionRepository } = await import('@/lib/review/promote-edition');

    vi.mocked(prisma.repository.findUnique).mockResolvedValue({
      id: 'repo-new',
      owner: 'testowner',
      repo: 'testrepo',
      edition: 'ed_custom',
      isPublic: false,
      reviewPipeline: {},
    } as any);

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      role: 'ADMIN',
      tier: 'ENTERPRISE',
    } as any);

    vi.mocked(callSidecar).mockResolvedValue({
      ok: true,
      promotedRepoId: 'repo-new',
      oldDefaultRepoId: 'repo-old',
      migratedSaves: 5,
    });

    const res = await promoteEditionRepository('user-1', { repoId: 'repo-new' });

    expect(res.success).toBe(true);
    expect(notifyClientRevalidate).toHaveBeenCalledWith([PUBLIC_HOME_CACHE_TAG], ['repo-new', 'repo-old']);
  });
});
