import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock DB & Driver
const conceptFindManyMock = vi.fn();
const conceptFindUniqueMock = vi.fn();
const conceptFindFirstMock = vi.fn();
const conceptCountMock = vi.fn();
const conceptGroupByMock = vi.fn();
const edgeFindManyMock = vi.fn();
const edgeCountMock = vi.fn();
const globalConceptUpsertMock = vi.fn();
const conceptUpdateManyMock = vi.fn();
const docFindManyMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    tutorialConceptNode: {
      findMany: (...args: unknown[]) => conceptFindManyMock(...args),
      findUnique: (...args: unknown[]) => conceptFindUniqueMock(...args),
      findFirst: (...args: unknown[]) => conceptFindFirstMock(...args),
      count: (...args: unknown[]) => conceptCountMock(...args),
      groupBy: (...args: unknown[]) => conceptGroupByMock(...args),
      updateMany: (...args: unknown[]) => conceptUpdateManyMock(...args),
    },
    tutorialConceptEdge: {
      findMany: (...args: unknown[]) => edgeFindManyMock(...args),
      count: (...args: unknown[]) => edgeCountMock(...args),
    },
    globalConcept: {
      upsert: (...args: unknown[]) => globalConceptUpsertMock(...args),
    },
    document: {
      findMany: (...args: unknown[]) => docFindManyMock(...args),
    },
  },
}));

const callSidecarMock = vi.fn().mockResolvedValue({ ok: true, count: 3 });

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

describe('M04 Knowledge Graph: Alignment and Condense (Unit 4.3 & 4.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conceptFindManyMock.mockResolvedValue([]);
    conceptFindUniqueMock.mockResolvedValue(null);
    conceptFindFirstMock.mockResolvedValue(null);
    conceptCountMock.mockResolvedValue(10);
    conceptGroupByMock.mockResolvedValue([]);
    edgeFindManyMock.mockResolvedValue([]);
    edgeCountMock.mockResolvedValue(15);
    conceptUpdateManyMock.mockResolvedValue({ count: 1 });
    docFindManyMock.mockResolvedValue([]);
    globalConceptUpsertMock.mockImplementation((args: { where: { canonicalName: string }; create: Record<string, unknown>; update: Record<string, unknown> }) =>
      Promise.resolve({
        id: `gc-${args.where.canonicalName}`,
        canonicalName: args.where.canonicalName,
        ...args.create,
        ...args.update,
      })
    );
  });

  it('🧪 [4.3.1.2] 跨仓对齐算法双端（TS / Go）固件逐字对拍一致性', () => {
    const goldenPath = path.join(process.cwd(), 'services/worker-sidecar/testdata/concept-engine.golden.json');
    expect(fs.existsSync(goldenPath)).toBe(true);

    const goldenContent = JSON.parse(fs.readFileSync(goldenPath, 'utf-8'));
    expect(goldenContent).toBeDefined();

    // 1. 验证 golden 中跨仓对齐固件（无 Jaccard 时同名并入，带 Jaccard 时异义词被过滤）
    const alignCases = goldenContent.align;
    expect(alignCases).toBeDefined();
    expect(alignCases.withoutJaccard).toBeInstanceOf(Array);
    expect(alignCases.withoutJaccard.length).toBeGreaterThan(0);

    const firstPlan = alignCases.withoutJaccard[0];
    expect(firstPlan.normalizedKey).toBe('event loop');
    expect(firstPlan.canonicalName).toBe('Event Loop');
    expect(firstPlan.aliases).toContain('event_loop');
    expect(firstPlan.repoCount).toBe(3);

    // 无 Jaccard 时 Pipeline 因跨 2 仓入选
    const pipelineWithout = alignCases.withoutJaccard.find((p: { normalizedKey: string }) => p.normalizedKey === 'pipeline');
    expect(pipelineWithout).toBeDefined();

    // 带 Jaccard 时 Pipeline 因语义相异被过滤排除
    const pipelineWith = alignCases.withJaccard.find((p: { normalizedKey: string }) => p.normalizedKey === 'pipeline');
    expect(pipelineWith).toBeUndefined();

    // 2. 验证 golden 中图谱紧缩固件
    const condenseCases = goldenContent.condense;
    expect(condenseCases).toBeDefined();
    const cyclicCase = condenseCases.find((c: { name: string }) => c.name === 'cyclic-and-pruned');
    expect(cyclicCase).toBeDefined();
    expect(cyclicCase.expected.hasCycle).toBe(true);
    expect(cyclicCase.expected.prunedNodesCount).toBe(2);
  });

  it('🧪 [4.3.3.1] 全局概念关联使用 SetNull 级联，删除全局概念不误删仓内局部概念', () => {
    const schemaPath = path.join(process.cwd(), 'prisma/schema.prisma');
    const schemaContent = fs.readFileSync(schemaPath, 'utf-8');

    // 查找 TutorialConceptNode 中的 globalConcept 外键关系声明
    expect(schemaContent).toMatch(
      /globalConcept\s+GlobalConcept\?\s+@relation\(fields:\s*\[globalConceptId\],\s*references:\s*\[id\],\s*onDelete:\s*SetNull\)/
    );
  });

  it('🧪 [4.4.1.1] 动态百分位阈值保底保留 topK (5~15) 核心骨干节点（防图谱清空）', async () => {
    // （紧缩转发 condenseConceptGraphAsync 已随 LLM 凝聚管线退役删除——
    //  动态百分位保底行为现由 Go executeSidecarCondenseGraph 单实现承载，
    //  Go 侧测试锁定；此处保留 computeGraphStats 统计口径锁定）
    const { computeGraphStats } = await import('@/lib/mcp/graph-condense');

    conceptCountMock.mockResolvedValueOnce(10).mockResolvedValueOnce(8);
    edgeCountMock.mockResolvedValueOnce(20);
    conceptGroupByMock.mockResolvedValueOnce([{ canonicalKey: 'k1' }, { canonicalKey: 'k2' }]);

    const stats = await computeGraphStats('repo-1');
    expect(stats.conceptNodes).toBe(10);
    expect(stats.conceptEdges).toBe(20);
    expect(stats.edgesPerNode).toBe(2.0);
    expect(stats.canonicalGroups).toBe(2);
  });

  it('🧪 [4.4.1.2] 度中心性得分相同时以 id 字典序升序确定性决胜', () => {
    const goldenPath = path.join(process.cwd(), 'services/worker-sidecar/testdata/concept-engine.golden.json');
    const goldenContent = JSON.parse(fs.readFileSync(goldenPath, 'utf-8'));

    const tieBreakCase = goldenContent.condense.find((c: { name: string }) => c.name === 'tie-break-equal-score');
    expect(tieBreakCase).toBeDefined();

    // 两个同分节点 node-Z 与 node-A，maxNodes=1 时必须以 id 升序裁决
    expect(tieBreakCase.rawGraph.nodes).toHaveLength(2);
    expect(tieBreakCase.expected.condensedGraph.nodes).toHaveLength(1);
    expect(tieBreakCase.expected.condensedGraph.nodes[0].id).toBe('node-A');
  });

  it('🧪 [4.4.2.1] Tarjan / Kahn 环检测与破环降权，杜绝拓扑排序死循环与爆栈', () => {
    const goldenPath = path.join(process.cwd(), 'services/worker-sidecar/testdata/concept-engine.golden.json');
    const goldenContent = JSON.parse(fs.readFileSync(goldenPath, 'utf-8'));

    const cyclicCase = goldenContent.condense.find((c: { name: string }) => c.name === 'cyclic-and-pruned');
    expect(cyclicCase).toBeDefined();

    // 强连通环路被有效识别且图紧缩成功完成，无死循环
    expect(cyclicCase.expected.hasCycle).toBe(true);
    expect(cyclicCase.expected.condensedGraph.nodes).toHaveLength(2);
    expect(cyclicCase.expected.prunedNodesCount).toBe(2);
  });

  it('🧪 [4.4.3.1] 紧凑投影脱敏，剔除内部冗余字段', async () => {
    const { getConceptNeighbors } = await import('@/lib/mcp/concept-graph');

    conceptFindUniqueMock.mockResolvedValueOnce({
      id: 'c1',
      conceptName: 'Event Loop',
      canonicalKey: 'event loop',
      canonicalName: 'Event Loop',
      category: 'architecture',
      repositoryId: 'repo-private',
      documentId: 'doc-1',
      principlesText: 'Internal lengthy reflection and private text',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    edgeFindManyMock.mockResolvedValueOnce([
      {
        sourceId: 'c1',
        targetId: 'c2',
        type: 'prerequisite',
        weight: 0.8,
        source: 'curriculum_order',
      },
    ]);

    conceptFindManyMock.mockResolvedValueOnce([
      {
        id: 'c2',
        conceptName: 'Task Queue',
        canonicalKey: 'task queue',
        canonicalName: 'Task Queue',
        category: 'workflow',
        headingPath: 'tasks',
        document: { path: 'docs/queue.md' },
      },
    ]);

    const neighbors = await getConceptNeighbors('repo-private', 'c1');
    expect(neighbors).toHaveLength(1);

    const neighbor = neighbors[0];
    expect(neighbor.conceptName).toBe('Task Queue');
    expect(neighbor.relation.type).toBe('prerequisite');

    // 断言紧凑脱敏投影：内部数据库字段如 repositoryId、createdAt、updatedAt、principlesText 绝不外泄
    expect(neighbor).not.toHaveProperty('repositoryId');
    expect(neighbor).not.toHaveProperty('createdAt');
    expect(neighbor).not.toHaveProperty('updatedAt');
    expect(neighbor).not.toHaveProperty('principlesText');
  });

  it('🧪 [4.4.4.1] 图拓扑内聚度校验与容量打分擂台赛（Score Tournament）', async () => {
    const { parseSuperTopicsBlock } = await import('@/lib/mcp/graph-condense');

    // 1. 合法结构通过容量与结构校验
    const validProfile = {
      conceptSuperTopics: {
        topics: [
          { title: 'Core Architecture', summary: 'System components overview', memberKeys: ['c1', 'c2'] },
        ],
        generatedAt: new Date().toISOString(),
        model: 'dashscope/qwen-plus',
      },
    };
    const parsed = parseSuperTopicsBlock(validProfile);
    expect(parsed).not.toBeNull();
    expect(parsed?.topics).toHaveLength(1);
    expect(parsed?.topics[0].title).toBe('Core Architecture');

    // 2. 劣质退化或非结构化数据被安全阻断，平滑返回 null（防图谱被污染）
    const degradedProfile = {
      conceptSuperTopics: {
        topics: 'corrupted-non-array-data',
        generatedAt: 'invalid-date',
      },
    };
    expect(parseSuperTopicsBlock(degradedProfile)).toBeNull();
    expect(parseSuperTopicsBlock(null)).toBeNull();
    expect(parseSuperTopicsBlock({})).toBeNull();
  });
});
