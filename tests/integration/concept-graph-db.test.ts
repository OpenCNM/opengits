import { test, expect, describe, afterAll, beforeAll } from 'vitest';
import { prisma } from '@/lib/db';
import {
  resolveConceptNode,
  getConceptNeighbors,
} from '@/lib/mcp/concept-graph';
import { ENGINE_CONFIG } from '@/lib/config';

describe('concept-graph DB 级消歧与图谱关联集成测试', () => {
  const testOwner = `cgraph-owner-${Date.now()}`;
  const testRepo = `cgraph-repo-${Date.now()}`;
  let repoId = '';
  let docId = '';
  let concept1Id = '';
  let concept2Id = '';
  let concept3Id = '';

  beforeAll(async () => {
    const repo = await prisma.repository.create({
      data: {
        owner: testOwner,
        repo: testRepo,
        branch: ENGINE_CONFIG.defaultBranch,
        isPublic: true,
        category: 'Testing',
      },
    });
    repoId = repo.id;

    const doc = await prisma.document.create({
      data: {
        repositoryId: repo.id,
        path: 'docs/virtual-dom.md',
        title: 'Virtual DOM Guide',
        content: '# Virtual DOM\n\nExplanation of virtual dom and diffing algorithm.',
        status: 'PROCESSED',
      },
    });
    docId = doc.id;

    const c1 = await prisma.tutorialConceptNode.create({
      data: {
        repositoryId: repo.id,
        documentId: doc.id,
        chunkId: 'chunk-core',
        conceptName: '虚拟 DOM 核心机制',
        slug: 'virtual-dom-core',
        category: 'architecture',
        principlesText: 'Virtual DOM 是 UI 的纯 JS 对象表达',
        summary: '虚拟 DOM 核心机制',
        headingPath: 'Virtual DOM > 核心机制',
      },
    });
    concept1Id = c1.id;

    const c2 = await prisma.tutorialConceptNode.create({
      data: {
        repositoryId: repo.id,
        documentId: doc.id,
        chunkId: 'chunk-core',
        conceptName: 'Diff 算法',
        slug: 'diff-algorithm',
        category: 'workflow',
        principlesText: '通过同层比较与 Key 优化降低复杂度至 O(n)',
        summary: 'Diff 算法',
        headingPath: 'Virtual DOM > Diff 算法',
      },
    });
    concept2Id = c2.id;

    const c3 = await prisma.tutorialConceptNode.create({
      data: {
        repositoryId: repo.id,
        documentId: doc.id,
        chunkId: 'chunk-fiber',
        conceptName: 'Fiber 协调器',
        slug: 'fiber-reconciler',
        category: 'architecture',
        principlesText: '基于链表的可中断异步任务调度',
        summary: 'Fiber 协调器',
        headingPath: 'Virtual DOM > Fiber 协调器',
      },
    });
    concept3Id = c3.id;
  });

  afterAll(async () => {
    if (repoId) {
      await prisma.tutorialConceptEdge.deleteMany({ where: { repositoryId: repoId } }).catch(() => {});
      await prisma.tutorialConceptNode.deleteMany({ where: { repositoryId: repoId } }).catch(() => {});
      await prisma.document.deleteMany({ where: { repositoryId: repoId } }).catch(() => {});
      await prisma.repository.delete({ where: { id: repoId } }).catch(() => {});
    }
  });

  describe('resolveConceptNode 两阶段消歧', () => {
    test('阶段 1：通过 slug 精确匹配', async () => {
      const node = await resolveConceptNode(repoId, 'virtual-dom-core');
      expect(node).not.toBeNull();
      expect(node?.id).toBe(concept1Id);
      expect(node?.conceptName).toBe('虚拟 DOM 核心机制');
    });

    test('阶段 1：通过 conceptName 大小写不敏感精确匹配', async () => {
      const node = await resolveConceptNode(repoId, 'diff 算法');
      expect(node).not.toBeNull();
      expect(node?.id).toBe(concept2Id);
    });

    test('阶段 2：通过前缀 startsWith 兜底匹配', async () => {
      const node = await resolveConceptNode(repoId, '虚拟 DOM');
      expect(node).not.toBeNull();
      expect(node?.id).toBe(concept1Id);
    });

    test('未命中时安全返回 null', async () => {
      const node = await resolveConceptNode(repoId, '完全不存在的未定义概念');
      expect(node).toBeNull();
    });
  });

  describe('getConceptNeighbors 真实边关联与邻居查询', () => {
    test('查询概念关联的直接邻居与 Address 生成', async () => {
      // 人工添加一条前置边：Fiber 是 Diff 的前置
      await prisma.tutorialConceptEdge.create({
        data: {
          repositoryId: repoId,
          sourceId: concept3Id,
          targetId: concept2Id,
          type: 'prerequisite',
          weight: 0.8,
          source: 'manual',
        },
      });

      const neighbors = await getConceptNeighbors(repoId, concept2Id);
      expect(neighbors.length).toBeGreaterThan(0);

      const incomingNeighbor = neighbors.find((n) => n?.conceptId === concept3Id);
      expect(incomingNeighbor).toBeDefined();
      expect(incomingNeighbor?.conceptName).toBe('Fiber 协调器');
      expect(incomingNeighbor?.address).toContain('docs/virtual-dom.md#');
    });

    test('同篇动态补充：无物化边的同文档概念以 co_located 伪边出现在邻居尾部', async () => {
      // c3 与 c1 同文档但无边（chunk 不同、无人工边）→ 读侧 documentId 直查补充
      const neighbors = await getConceptNeighbors(repoId, concept3Id);

      const coLocated = neighbors.find((n) => n?.relation.type === 'co_located');
      expect(coLocated).toBeDefined();
      expect(coLocated?.conceptName).toBe('虚拟 DOM 核心机制');
      expect(coLocated?.relation.direction).toBe('undirected');
    });
  });
});
