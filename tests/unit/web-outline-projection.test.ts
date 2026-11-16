import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getWebL1OutlineProjection,
  getWebL1OutlineProjectionById,
  setWebL1OutlineProjection,
  invalidateWebL1Projection,
  clearWebL1ProjectionsForTest,
  getWebL1ProjectionsCountForTest,
  type WebL1OutlineProjection,
} from '@/lib/docs/web-outline-projection';
import { resolveEffectiveNavTree, projectNavTreeFromOutline } from '@/lib/mcp/outline-projector';
import { loadDocsLayoutData } from '@/lib/docs/docs-layout-loader';
import { prisma } from '@/lib/db';
import { resolveRepository, resolveRepositoryAnyEdition } from '@/lib/repository-resolver';
import type { OutlineView } from '@/lib/outline-reader';
import type { NavNode } from '@/engine/structurizer';

// ── Mock DB and auth dependencies ──
vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    document: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    tutorialOutline: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    helpfulVote: {
      findUnique: vi.fn(),
    },
    userReadingProgress: {
      findFirst: vi.fn(),
    },
    chapterUpdateJob: {
      findMany: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth-utils', () => ({
  verifyRepoAccessDirect: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/repository-resolver', () => ({
  resolveRepository: vi.fn(),
  resolveRepositoryAnyEdition: vi.fn(),
  getRepositoryEditions: vi.fn().mockResolvedValue([]),
  resolveRepositoryDisplayName: vi.fn((p: any) => p?.title || 'Mock Title'),
  findPublicGroupRow: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/reading-fingerprint-adapter', () => ({
  computeProgressBatch: vi.fn().mockResolvedValue({}),
}));

function createMockOutline(repoId: string = 'repo-1'): OutlineView {
  return {
    outlineId: 'outline-1',
    version: 3,
    mode: 'tutorial',
    parts: [
      {
        id: 'part-1',
        title: 'Getting Started',
        summary: 'Introductory chapters',
        teachingOrder: 0,
        chapters: [
          {
            id: 'ch-1',
            title: 'Installation',
            summary: 'How to install',
            chapterType: 'doc',
            teachingOrder: 0,
            nodes: [
              {
                id: 'n-1',
                title: 'Quickstart',
                nodeType: 'doc',
                headingPath: null,
                documentId: 'doc-1',
                docPath: 'guide/quickstart.md',
                docStatus: 'PROCESSED',
              },
            ],
          },
        ],
      },
    ],
    chapters: [
      {
        id: 'ch-2',
        title: 'Core Concepts',
        summary: 'Deep dive into core mechanics',
        chapterType: 'doc',
        teachingOrder: 1,
        nodes: [
          {
            id: 'n-2',
            title: 'Architecture',
            nodeType: 'doc',
            headingPath: null,
            documentId: 'doc-2',
            docPath: 'concepts/arch.md',
            docStatus: 'PROCESSED',
          },
        ],
      },
    ],
  };
}

function createMockProjection(
  owner: string = 'test-owner',
  repo: string = 'test-repo',
  edition: string = ''
): WebL1OutlineProjection {
  const outline = createMockOutline('repo-abc');
  const navTree: NavNode[] = projectNavTreeFromOutline(outline, { owner, repo });
  const docPaths = ['guide/quickstart.md', 'concepts/arch.md'];

  return {
    repositoryId: 'repo-abc',
    owner,
    repo,
    branch: 'main',
    edition,
    gitSha: 'sha-12345',
    outlineVersion: outline.version,
    outline,
    navTree,
    docPaths,
    teachingDocPaths: docPaths,
    editionOptions: [],
    repoSnapshot: {
      id: 'repo-abc',
      owner,
      repo,
      branch: 'main',
      edition,
      isPublic: true,
      repoProfile: { title: 'Test Repo' },
      transcriptionModels: ['gpt-4o'],
      transcriptionTokens: 5000,
      helpfulCount: 42,
      navTree,
    },
    builtAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

describe('Web L1 In-Memory Outline Projection (Unit 1.11 · Direction 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearWebL1ProjectionsForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearWebL1ProjectionsForTest();
  });

  describe('1. L1 内存投影 Hit / Miss / TTL 过期惰性清理', () => {
    it('命中返回有效投影，未命中返回 null', async () => {
      const proj = createMockProjection('facebook', 'react');
      setWebL1OutlineProjection(proj);

      const hit = await getWebL1OutlineProjection('facebook', 'react');
      expect(hit).not.toBeNull();
      expect(hit?.repositoryId).toBe('repo-abc');
      expect(hit?.outlineVersion).toBe(proj.outlineVersion);

      const miss = await getWebL1OutlineProjection('facebook', 'vue');
      expect(miss).toBeNull();
    });

    it('TTL 过期后惰性清理并返回 null', async () => {
      const expiredProj = createMockProjection('org', 'expired-repo');
      expiredProj.expiresAt = Date.now() - 1000; // already expired
      setWebL1OutlineProjection(expiredProj);

      const res = await getWebL1OutlineProjection('org', 'expired-repo');
      expect(res).toBeNull();
      expect(getWebL1ProjectionsCountForTest()).toBe(0);
    });

    it('通过 repositoryId 只读获取 L1 投影', async () => {
      const proj = createMockProjection('vercel', 'next.js');
      setWebL1OutlineProjection(proj);

      const hitById = await getWebL1OutlineProjectionById('repo-abc');
      expect(hitById).not.toBeNull();
      expect(hitById?.owner).toBe('vercel');

      const missById = await getWebL1OutlineProjectionById('non-existent');
      expect(missById).toBeNull();
    });

    it('同 key 覆写但 repoId 变更时，旧 repoId 反向索引被彻底清理', async () => {
      const projOld = createMockProjection('facebook', 'react', '');
      projOld.repositoryId = 'repo-old';
      setWebL1OutlineProjection(projOld);

      expect(await getWebL1OutlineProjectionById('repo-old')).not.toBeNull();

      const projNew = createMockProjection('facebook', 'react', '');
      projNew.repositoryId = 'repo-new';
      setWebL1OutlineProjection(projNew);

      // 旧 repoId 已被清理，新 repoId 可读
      expect(await getWebL1OutlineProjectionById('repo-old')).toBeNull();
      expect(await getWebL1OutlineProjectionById('repo-new')).not.toBeNull();
    });
  });

  describe('2. Singleflight 并发防击穿 (Concurreny Deduplication)', () => {
    // 🧪 [1.11.4.4 · CRITICAL] Web SSR/RSC 端接入纯内存大纲投影与 Singleflight 防击穿
    it('🧪 [1.11.4.4] 模拟 20 个并发读者同时打冷仓，底层 Loader 仅触发 1 次', async () => {
      let loaderCalls = 0;
      const mockLoader = async () => {
        loaderCalls++;
        await new Promise((r) => setTimeout(r, 10)); // 模拟轻微网络/DB延迟
        return createMockProjection('cold-owner', 'cold-repo');
      };

      const promises = Array.from({ length: 20 }, () =>
        getWebL1OutlineProjection('cold-owner', 'cold-repo', undefined, mockLoader)
      );

      const results = await Promise.all(promises);

      expect(loaderCalls).toBe(1);
      expect(results).toHaveLength(20);
      for (const res of results) {
        expect(res).not.toBeNull();
        expect(res?.owner).toBe('cold-owner');
        expect(res?.repo).toBe('cold-repo');
      }

      // 后续调用直接命中内存缓存，loader 仍为 1 次
      const immediate = await getWebL1OutlineProjection('cold-owner', 'cold-repo');
      expect(immediate).not.toBeNull();
      expect(loaderCalls).toBe(1);
    });

    it('loadDocsLayoutData 面对 20 个并发读者冷启动时，DB 解析器仅触发 1 次', async () => {
      let dbResolveCalls = 0;
      const mockRepoRow = {
        id: 'repo-concurrent-1',
        owner: 'concurrent-org',
        repo: 'concurrent-repo',
        branch: 'main',
        edition: '',
        isPublic: true,
        gitSha: 'sha-conc-1',
        repoProfile: { title: 'Concurrent Repo' },
        transcriptionModels: [],
        transcriptionTokens: 0,
        helpfulCount: 5,
        navTree: [
          {
            name: 'quickstart',
            title: 'Quickstart',
            type: 'file',
            path: 'quickstart.md',
            url: '/docs/concurrent-org/concurrent-repo/quickstart',
          },
        ],
      };

      vi.mocked(resolveRepositoryAnyEdition).mockImplementation(async () => {
        dbResolveCalls++;
        await new Promise((r) => setTimeout(r, 15));
        return {
          repository: mockRepoRow as any,
          resolvedBranch: 'main',
          targetVersionLabel: undefined,
          isFallback: false,
          resolvedEdition: '',
        };
      });

      const promises = Array.from({ length: 20 }, () =>
        loadDocsLayoutData('concurrent-org', 'concurrent-repo', undefined)
      );

      const results = await Promise.all(promises);
      expect(results).toHaveLength(20);
      expect(dbResolveCalls).toBe(1); // 严格仅向底层 DB 发起 1 次查询！
      for (const res of results) {
        expect(res.status).toBe('ready');
      }
    });
  });

  describe('3. 双轨对拍等价性 (projection.navTree === resolveEffectiveNavTree)', () => {
    it('断言 L1 内存投影 navTree 与 resolveEffectiveNavTree 原生纯函数结果 100% 逐字段相等', async () => {
      const proj = createMockProjection('facebook', 'react');
      setWebL1OutlineProjection(proj);

      // 通过 resolveEffectiveNavTree 访问，无显式事务时应直接命中 L1 内存投影
      const resolvedTree = await resolveEffectiveNavTree(proj.repositoryId);
      expect(resolvedTree).toEqual(proj.navTree);

      // 与 projectNavTreeFromOutline 原生确定性投影结果比对
      const directTree = projectNavTreeFromOutline(proj.outline, { owner: 'facebook', repo: 'react' });
      expect(resolvedTree).toEqual(directTree);
    });

    it('resolveEffectiveNavTree 显式传入自定义 options.outline 时直接投影，不被 L1 缓存劫持', async () => {
      const proj = createMockProjection('facebook', 'react');
      setWebL1OutlineProjection(proj);

      const customOutline: OutlineView = {
        outlineId: 'outline-custom',
        version: 99,
        mode: 'tutorial',
        parts: [],
        chapters: [
          {
            id: 'ch-custom',
            title: 'Custom Chapter',
            summary: 'Custom summary',
            chapterType: 'doc',
            teachingOrder: 0,
            nodes: [
              {
                id: 'n-custom',
                title: 'Custom Chapter',
                nodeType: 'doc',
                headingPath: null,
                documentId: 'doc-custom',
                docPath: 'custom.md',
                docStatus: 'PROCESSED',
              },
            ],
          },
        ],
      };

      const customTree = await resolveEffectiveNavTree(proj.repositoryId, {
        owner: 'facebook',
        repo: 'react',
        outline: customOutline,
      });

      // 显式大纲应被执行并返回自定义大纲对应的树结构
      expect(customTree).not.toEqual(proj.navTree);
      expect(customTree[0]?.title).toBe('Custom Chapter');
    });
  });

  describe('4. 精确失效与反向索引淘汰 (invalidateWebL1Projection)', () => {
    it('通过 repositoryId 精确淘汰 L1 投影', async () => {
      const proj = createMockProjection('apple', 'swift');
      setWebL1OutlineProjection(proj);

      expect(await getWebL1OutlineProjection('apple', 'swift')).not.toBeNull();
      invalidateWebL1Projection('repo-abc'); // by repoId
      expect(await getWebL1OutlineProjection('apple', 'swift')).toBeNull();
      expect(await getWebL1OutlineProjectionById('repo-abc')).toBeNull();
    });

    it('通过 owner/repo:edition 键精确淘汰', async () => {
      const proj1 = createMockProjection('google', 'go', '');
      const proj2 = { ...createMockProjection('google', 'go', 'advanced'), repositoryId: 'repo-go-adv' };
      setWebL1OutlineProjection(proj1);
      setWebL1OutlineProjection(proj2);

      invalidateWebL1Projection('google/go:advanced');
      expect(await getWebL1OutlineProjection('google', 'go', 'advanced')).toBeNull();
      expect(await getWebL1OutlineProjection('google', 'go', '')).not.toBeNull();
    });

    it('支持大小写混合的 edition 键统一归一化与失效', async () => {
      const proj = createMockProjection('org', 'repo', 'Standard-Edition');
      setWebL1OutlineProjection(proj);

      // 通过大小写不敏感的查询命中
      const hit = await getWebL1OutlineProjection('org', 'repo', 'standard-edition');
      expect(hit).not.toBeNull();

      // 通过原始大小写 key 失效
      invalidateWebL1Projection('org/repo:Standard-Edition');
      expect(await getWebL1OutlineProjection('org', 'repo', 'standard-edition')).toBeNull();
    });

    it('通过 owner/repo 模糊前缀淘汰该仓所有 edition 讲法', async () => {
      const proj1 = createMockProjection('rust-lang', 'rust', '');
      const proj2 = { ...createMockProjection('rust-lang', 'rust', 'nightly'), repositoryId: 'repo-rust-nightly' };
      setWebL1OutlineProjection(proj1);
      setWebL1OutlineProjection(proj2);

      invalidateWebL1Projection('rust-lang/rust');
      expect(await getWebL1OutlineProjection('rust-lang', 'rust', '')).toBeNull();
      expect(await getWebL1OutlineProjection('rust-lang', 'rust', 'nightly')).toBeNull();
    });
  });

  describe('5. Web 阅读器数据加载层 0 SQL Fast-Path', () => {
    it('loadDocsLayoutData 在命中 L1 内存投影且为匿名读者访问公开仓时，Prisma 查询归零', async () => {
      const proj = createMockProjection('test-org', 'fast-repo');
      setWebL1OutlineProjection(proj);

      const result = await loadDocsLayoutData('test-org', 'fast-repo', undefined);

      expect(result.status).toBe('ready');
      if (result.status === 'ready') {
        expect(result.repositoryId).toBe('repo-abc');
        expect(result.repository.owner).toBe('test-org');
        expect(result.outline?.outlineId).toBe('outline-1');
        expect(result.navTree).toEqual(proj.navTree);
        expect(result.isAuthorized).toBe(true);
      }

      // 验证 0 项 Prisma 查询执行！
      expect(prisma.repository.findUnique).not.toHaveBeenCalled();
      expect(prisma.repository.findFirst).not.toHaveBeenCalled();
      expect(prisma.document.findMany).not.toHaveBeenCalled();
      expect(prisma.tutorialOutline.findFirst).not.toHaveBeenCalled();
    });

    it('loadDocsLayoutData 传入自定义 edition 时准确调用 resolveRepository 并隔离缓存', async () => {
      const mockEditionRepo = {
        id: 'repo-custom-ed',
        owner: 'test-org',
        repo: 'custom-repo',
        branch: 'main',
        edition: 'expert',
        isPublic: true,
        gitSha: 'sha-expert',
        repoProfile: { title: 'Expert Edition' },
        transcriptionModels: [],
        transcriptionTokens: 0,
        helpfulCount: 1,
        navTree: [
          {
            name: 'expert-guide',
            title: 'Expert Guide',
            type: 'file',
            path: 'expert.md',
            url: '/docs/test-org/custom-repo/expert',
          },
        ],
      };

      vi.mocked(resolveRepository).mockResolvedValueOnce({
        repository: mockEditionRepo as any,
        resolvedBranch: 'main',
        targetVersionLabel: undefined,
        isFallback: false,
        resolvedEdition: 'expert',
      });

      const res = await loadDocsLayoutData('test-org', 'custom-repo', undefined, 'expert');
      expect(res.status).toBe('ready');
      expect(resolveRepository).toHaveBeenCalledWith('test-org', 'custom-repo', undefined, 'expert');

      // 确认已写入该讲法专属的 L1 内存投影
      const cached = await getWebL1OutlineProjection('test-org', 'custom-repo', 'expert');
      expect(cached).not.toBeNull();
      expect(cached?.edition).toBe('expert');
      expect(cached?.repositoryId).toBe('repo-custom-ed');
    });
  });
});
