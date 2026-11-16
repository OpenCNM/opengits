import { test, expect, describe, afterAll, beforeAll } from 'vitest';
import { prisma } from '@/lib/db';
import {
  resolveConceptNode,
  getConceptNeighbors,
  getConceptDependencies,
  buildRepositoryConceptTaxonomy,
} from '@/lib/mcp/concept-graph';
import { applyCanonicalBackfillToRepository, refreshCanonicalNames } from '@/lib/mcp/concept-canonical';
import { normalizeHeadingKey } from '@/lib/mcp/concept-extractor';
import { ENGINE_CONFIG } from '@/lib/config';

describe('concept-canonical 仓内归并层 DB 集成测试', () => {
  const testOwner = `ccanon-owner-${Date.now()}`;
  const testRepo = `ccanon-repo-${Date.now()}`;
  let repoId = '';
  let doc1Id = '';
  let doc2Id = '';
  // 组「事件循环」的两个跨文档变体
  let headId = '';      // doc1 的「事件循环」（组内头部/代表）
  let variantId = '';   // doc2 的「1. 事件循环」（长尾变体）
  let upstreamId = '';  // 「渲染管线」：挂在头部变体上的前置概念

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

    const doc1 = await prisma.document.create({
      data: {
        repositoryId: repoId,
        path: 'docs/event-loop.md',
        title: 'Event Loop',
        content: '# Event Loop\n\nbody',
        status: 'PROCESSED',
      },
    });
    doc1Id = doc1.id;
    const doc2 = await prisma.document.create({
      data: {
        repositoryId: repoId,
        path: 'docs/advanced/event-loop.md',
        title: 'Event Loop Advanced',
        content: '# Event Loop Advanced\n\nbody',
        status: 'PROCESSED',
      },
    });
    doc2Id = doc2.id;

    // 模拟写入路径的归并字段落值（canonicalKey 由 normalizeHeadingKey 即得，代表名先取自身）
    const mkNode = (documentId: string, name: string, slug: string, headingPath: string) =>
      prisma.tutorialConceptNode.create({
        data: {
          repositoryId: repoId,
          documentId,
          conceptName: name,
          slug,
          category: 'architecture',
          headingPath,
          canonicalKey: normalizeHeadingKey(name),
          canonicalName: name,
        },
      });

    const head = await mkNode(doc1Id, '事件循环', 'loop-head', 'Event Loop');
    headId = head.id;
    const variant = await mkNode(doc2Id, '1. 事件循环', 'loop-variant', 'Event Loop > 进阶');
    variantId = variant.id;
    const upstream = await mkNode(doc1Id, '渲染管线', 'render-pipeline', 'Event Loop > 渲染');
    upstreamId = upstream.id;

    // 前置边只挂在「头部变体」上：渲染管线 → 事件循环(doc1)
    await prisma.tutorialConceptEdge.create({
      data: {
        repositoryId: repoId,
        sourceId: upstreamId,
        targetId: headId,
        type: 'prerequisite',
        weight: 0.9,
        source: 'curriculum_order',
      },
    });
  });

  afterAll(async () => {
    if (repoId) {
      await prisma.tutorialConceptEdge.deleteMany({ where: { repositoryId: repoId } }).catch(() => {});
      await prisma.tutorialConceptNode.deleteMany({ where: { repositoryId: repoId } }).catch(() => {});
      await prisma.document.deleteMany({ where: { repositoryId: repoId } }).catch(() => {});
      await prisma.repository.delete({ where: { id: repoId } }).catch(() => {});
    }
  });

  describe('applyCanonicalBackfillToRepository 存量回填', () => {
    test('按归一化名合并跨文档变体：代表名取频次最高者，回填幂等', async () => {
      const first = await applyCanonicalBackfillToRepository(repoId);
      expect(first.nodes).toBe(3);
      expect(first.groups).toBe(2); // 「事件循环」组 + 「渲染管线」组
      // 仅变体「1. 事件循环」的代表名需要纠正（head 与 渲染管线 已一致）
      expect(first.updated).toBe(1);

      // 组内代表名收敛为「事件循环」（2 次 > 变体 1 次）
      const variant = await prisma.tutorialConceptNode.findUnique({ where: { id: variantId } });
      expect(variant?.canonicalName).toBe('事件循环');

      // 幂等：第二次回填无更新
      const second = await applyCanonicalBackfillToRepository(repoId);
      expect(second.updated).toBe(0);
    });
  });

  describe('resolveConceptNode 归并维度解析', () => {
    test('通过归并名（canonicalName）精确命中组成员', async () => {
      const node = await resolveConceptNode(repoId, '事件循环');
      expect(node).not.toBeNull();
      expect([headId, variantId]).toContain(node!.id);
    });
  });

  describe('邻居/前置的组成员继承', () => {
    test('长尾变体继承头部变体的邻居（孤点不再返回空）', async () => {
      // variant 自身无边——归并继承后应看到挂在 head 上的「渲染管线」
      const neighbors = await getConceptNeighbors(repoId, variantId);
      const upstream = neighbors.find((n) => n.conceptId === upstreamId);
      expect(upstream).toBeDefined();
      expect(upstream?.relation.type).toBe('prerequisite');
    });

    test('前置查询按组成员集合取边（targetId in members）', async () => {
      const deps = await getConceptDependencies(repoId, variantId);
      expect(deps.length).toBeGreaterThan(0);
      expect(deps[0].conceptId).toBe(upstreamId);
    });

    test('组内互边不构成邻居（自组不算外邻）', async () => {
      // 组内加一条互边：variant → head 的 related
      await prisma.tutorialConceptEdge.create({
        data: {
          repositoryId: repoId,
          sourceId: variantId,
          targetId: headId,
          type: 'related',
          weight: 0.5,
          source: 'cooccurrence',
        },
      });
      const neighbors = await getConceptNeighbors(repoId, headId);
      expect(neighbors.find((n) => n.conceptId === variantId)).toBeUndefined();
    });
  });

  describe('buildRepositoryConceptTaxonomy 组去重', () => {
    test('同组变体只出一个代表，带 ×N 同义标注数据', async () => {
      const taxonomy = await buildRepositoryConceptTaxonomy(repoId, 50);
      const loopEntries = taxonomy.filter((t) => t.canonicalName === '事件循环' || t.conceptName === '事件循环');
      // 去重后组内只出现一行
      expect(loopEntries.length).toBe(1);
      expect(loopEntries[0].mergedVariants).toBe(2);
    });
  });

  describe('refreshCanonicalNames 组收缩重算', () => {
    test('删除代表成员后，刷新把代表名收敛到剩余变体', async () => {
      // 删除头部变体（名字 === 代表名），组内只剩「1. 事件循环」
      await prisma.tutorialConceptNode.delete({ where: { id: headId } });

      const updated = await refreshCanonicalNames(repoId, ['事件循环']);
      expect(updated).toBeGreaterThanOrEqual(1);

      const variant = await prisma.tutorialConceptNode.findUnique({ where: { id: variantId } });
      // 只剩一个成员时代表名收敛为其原名（去前导编号后的 key 对应的唯一变体）
      expect(variant?.canonicalName).toBe('1. 事件循环');
    });
  });
});
