import { test, expect } from 'vitest';
import {
  deriveCooccurrenceEdges,
  deriveCurriculumOrderEdges,
  computeNeighborMap,
  computeLearningPathChain,
  computeConceptDepths,
  filterPrerequisiteCandidates,
  formatLearningPathOutput,
  formatNeighborsOutput,
  formatDependencyHintText,
  formatConceptTaxonomyGrouped,
  neighborRelationTag,
  CONCEPT_DEPENDENCY_HINT_HEADER,
  computeRepoEdgeCap,
} from '@/lib/mcp/concept-graph';
import { extractConceptsFromMarkdown, matchChunkAnchor } from '@/lib/mcp/concept-extractor';

test('🧪 [4.2.1.1] filterPrerequisiteCandidates：教学大纲线性序反向依赖强先验惩罚截断（反向矛盾丢弃 / 传递成环丢弃）', () => {
  // 既有前置图：B→C（B 先学 C 后学）、C→A（C 先学 A 后学）
  const established = [
    { sourceId: 'b', targetId: 'c', type: 'successor', weight: 0.3 },
    { sourceId: 'c', targetId: 'a', type: 'successor', weight: 0.3 },
  ];
  const candidates = [
    // 反向矛盾：C→B 与既有 B→C 相反 → 丢弃
    { sourceId: 'c', targetId: 'b', type: 'prerequisite' as const, weight: 0.5, source: 'llm_extracted' as const },
    // 传递成环：B 已可达 A（B→C→A），A→B 会闭合 A→B→C→A → 丢弃
    { sourceId: 'a', targetId: 'b', type: 'prerequisite' as const, weight: 0.5, source: 'llm_extracted' as const },
    // 合法前置：B 前置于 D（D 不可达 B）→ 保留
    { sourceId: 'b', targetId: 'd', type: 'prerequisite' as const, weight: 0.5, source: 'llm_extracted' as const },
  ];
  const { kept, dropped } = filterPrerequisiteCandidates(candidates, established);
  expect(dropped).toBe(2);
  expect(kept).toHaveLength(1);
  expect(kept[0].sourceId).toBe('b');
  expect(kept[0].targetId).toBe('d');
});

test('filterPrerequisiteCandidates：related/part_of 不参与校验（学习路径不沿其行走）', () => {
  const established = [{ sourceId: 'b', targetId: 'c', type: 'successor', weight: 0.3 }];
  const { kept, dropped } = filterPrerequisiteCandidates(
    [
      { sourceId: 'c', targetId: 'b', type: 'related', weight: 0.5, source: 'llm_extracted' },
      { sourceId: 'b', targetId: 'c', type: 'part_of', weight: 0.5, source: 'llm_extracted' },
    ],
    established
  );
  expect(dropped).toBe(0);
  expect(kept).toHaveLength(2);
});

test('🧪 [4.2.2.1] deriveCooccurrenceEdges：仅同 Chunk 强共现与置信度阈值 >= 0.6 过滤（无自环 / 方向幂等）', () => {
  const concepts = [
    { id: 'a', documentId: 'doc1', chunkId: 'chunk1' },
    { id: 'b', documentId: 'doc1', chunkId: 'chunk1' },
    { id: 'c', documentId: 'doc1', chunkId: 'chunk2' }, // 同文档不同 Chunk → 不再建边
    { id: 'd', documentId: 'doc2', chunkId: null },     // 无 Chunk 锚点 → 不建边（同篇关系读侧动态查询）
    { id: 'e', documentId: null, chunkId: null },
  ];
  const cooc = deriveCooccurrenceEdges(concepts);
  expect(cooc).toHaveLength(1); // 仅 a-b（chunk1 内）
  const ab = cooc.find((e) => e.sourceId === 'a' && e.targetId === 'b')!;
  expect(ab.weight).toBe(1.0);
  expect(ab.weight).toBeGreaterThanOrEqual(0.6); // 置信度阈值 >= 0.6
  expect(ab.type).toBe('related');
  expect(ab.meta).toEqual({ chunkId: 'chunk1' });
  expect(cooc.every((e) => e.sourceId !== e.targetId)).toBe(true);
  expect(cooc.every((e) => e.sourceId < e.targetId)).toBe(true);
});

test('deriveCurriculumOrderEdges：每个后置概念一条代表前驱边（线性化），不跨组跳跃', () => {
  const curr = deriveCurriculumOrderEdges([['a', 'b'], ['c'], ['d', 'e']]);
  // c ← 代表前驱 a（id 最小者）；d、e ← c。共 1 + 2 = 3 条（旧笛卡尔积为 4 条，平方级膨胀）
  expect(curr).toHaveLength(3);
  expect(curr.every((e) => e.type === 'successor' && e.source === 'curriculum_order')).toBe(true);
  expect(curr.every((e) => !(e.sourceId === 'd' && e.targetId === 'c'))).toBe(true);
  // 不变量：后置组每个概念都有 ≥1 条来自前驱组的入边（learning_path 可达性）
  const targets = new Set(curr.map((e) => e.targetId));
  expect(targets.has('c')).toBe(true);
  expect(targets.has('d')).toBe(true);
  expect(targets.has('e')).toBe(true);
});

test('deriveCurriculumOrderEdges 方向语义：source=前驱（先学），target=后学', () => {
  const incr = deriveCurriculumOrderEdges([['prev1'], ['this1', 'this2']]);
  expect(incr).toHaveLength(2);
  expect(incr.every((e) => e.sourceId === 'prev1' && (e.targetId === 'this1' || e.targetId === 'this2'))).toBe(true);
});

test('computeNeighborMap：入边/出边分类', () => {
  const edges = [
    { sourceId: 'a', targetId: 'b', type: 'successor', weight: 0.3 },
    { sourceId: 'b', targetId: 'c', type: 'successor', weight: 0.3 },
    { sourceId: 'a', targetId: 'c', type: 'related', weight: 0.5 },
  ];
  const map = computeNeighborMap(edges);
  expect(map.get('a')!.outgoing).toHaveLength(2);
  expect(map.get('a')!.incoming).toHaveLength(0);
  expect(map.get('c')!.incoming).toHaveLength(2);
});

test('computeLearningPathChain：沿 successor 入边反向 BFS 分层', () => {
  const edges = [
    { sourceId: 'a', targetId: 'b', type: 'successor', weight: 0.3 },
    { sourceId: 'b', targetId: 'c', type: 'successor', weight: 0.3 },
    { sourceId: 'a', targetId: 'c', type: 'related', weight: 0.5 },
  ];
  const chain = computeLearningPathChain('c', edges, 4);
  expect(chain.some((s) => s.conceptId === 'a' && s.depth === 2)).toBe(true);
  expect(chain.some((s) => s.conceptId === 'b' && s.depth === 1)).toBe(true);
  expect(chain).toHaveLength(2);
});

test('格式化：学习路径含目标步骤与 Address；邻居含方向标注', () => {
  const lpText = formatLearningPathOutput('目标概念', [
    { conceptId: 'x', conceptName: '前置一', canonicalKey: null, canonicalName: null, category: 'workflow', depth: 1, docPath: 'book/a.md', headingPath: '前置一', address: 'book/a.md#前置一' },
  ]);
  expect(lpText).toContain('🎯 目标概念');
  expect(lpText).toContain('[Address: book/a.md#前置一]');

  const nbText = formatNeighborsOutput('目标概念', [
    { conceptId: 'y', conceptName: '邻居一', canonicalKey: null, canonicalName: null, category: 'reflection', docPath: 'book/b.md', headingPath: '邻居一', address: 'book/b.md#邻居一', relation: { direction: 'incoming', type: 'related', weight: 0.5, source: 'cooccurrence' }, edgeCount: 1 },
  ]);
  // related 无向关联统一走 ⇋（方向对无向边无意义）
  expect(nbText).toContain('⇋[相关]');
  expect(nbText).toContain('[Address: book/b.md#邻居一]');
});

test('formatNeighborsOutput 方向语义：incoming prerequisite = ⇠[前置]（历史反转修正）', () => {
  const text = formatNeighborsOutput('目标概念', [
    { conceptId: 'p', conceptName: '前置概念', canonicalKey: null, canonicalName: null, category: 'architecture', docPath: 'book/p.md', headingPath: '前置', address: 'book/p.md#前置', relation: { direction: 'incoming', type: 'prerequisite', weight: 0.6, source: 'code_dep' }, edgeCount: 1 },
  ]);
  expect(text).toContain('⇠[前置]');
  expect(text).not.toContain('⇢');
  expect(text).toContain('代码依赖');
  expect(text).toContain('确定');
  expect(text).toContain('w0.60');
});

test('🧪 [4.2.4.1] neighborRelationTag 修饰符注册与同篇 co_located 零物化读侧动态投影（不写库持久化）', () => {
  expect(neighborRelationTag({ type: 'prerequisite', direction: 'incoming' })).toBe('⇠[前置]');
  expect(neighborRelationTag({ type: 'prerequisite', direction: 'outgoing' })).toBe('⇢[后学]');
  expect(neighborRelationTag({ type: 'successor', direction: 'incoming' })).toBe('⇠[先学]');
  expect(neighborRelationTag({ type: 'successor', direction: 'outgoing' })).toBe('⇢[后继]');
  expect(neighborRelationTag({ type: 'part_of', direction: 'incoming' })).toBe('⇠[组成部分]');
  expect(neighborRelationTag({ type: 'co_located', direction: 'undirected' })).toBe('⇋[同篇]');
  expect(neighborRelationTag({ type: 'related', direction: 'outgoing' })).toBe('⇋[相关]');
});

test('🧪 [4.2.3.1] 复合唯一键 @@unique([sourceId, targetId, relationType]) 防重边插入与双向级联删除', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const schemaContent = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf-8');

  // 1. Prisma schema 复合唯一键约束（sourceId, targetId, type 唯一元组防重边）
  const edgeModelMatch = schemaContent.match(/model TutorialConceptEdge\s*\{[\s\S]*?\n\}/);
  expect(edgeModelMatch).not.toBeNull();
  const edgeBlock = edgeModelMatch![0];
  expect(edgeBlock).toMatch(/@@unique\(\[sourceId,\s*targetId,\s*type\]\)/);

  // 2. 双向物理级联删除（节点删除时自动清理脏边，防止悬空脏边堆积）
  expect(edgeBlock).toMatch(/sourceNode\s+TutorialConceptNode\s+@relation\("edgeSource",\s*fields:\s*\[sourceId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/);
  expect(edgeBlock).toMatch(/targetNode\s+TutorialConceptNode\s+@relation\("edgeTarget",\s*fields:\s*\[targetId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/);
  expect(edgeBlock).toMatch(/repository\s+Repository\s+@relation\(fields:\s*\[repositoryId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/);

  // 3. 边同步层入库写入时声明防重（下沉 Go 侧通过 ON CONFLICT DO NOTHING 保证）
  const goStoreContent = fs.readFileSync(path.join(process.cwd(), 'services/worker-sidecar/internal/userinteraction/store_concept_graph.go'), 'utf-8');
  expect(goStoreContent).toContain('ON CONFLICT ("sourceId", "targetId", "type") DO NOTHING');
});

test('🧪 [4.2.5.1] resolveTeachingDocPaths 单一事实源展平与边序一致性', async () => {
  const { flattenNavTreeEntries } = await import('@/lib/outline-reader');

  const navTree = [
    {
      name: 'part1',
      title: '第 1 部分',
      type: 'directory' as const,
      path: 'part1',
      children: [
        { name: 'intro.md', title: '介绍', shortTitle: 'Intro', type: 'file' as const, path: 'part1/intro.md' },
        { name: 'setup.md', title: '安装', type: 'file' as const, path: 'part1/setup.md' },
      ],
    },
    {
      name: 'part2',
      title: '第 2 部分',
      type: 'directory' as const,
      path: 'part2',
      children: [
        { name: 'core.md', title: '核心', type: 'file' as const, path: 'part2/core.md' },
      ],
    },
  ];

  // flattenNavTreeFiles 已收窄为 outline-reader 私有（路径投影 = entries.map(e => e.path)）
  const files = flattenNavTreeEntries(navTree as never).map((e) => e.path);
  expect(files).toEqual(['part1/intro.md', 'part1/setup.md', 'part2/core.md']);

  // 教学大纲顺序边按单一事实源顺序构建
  const orderEdges = deriveCurriculumOrderEdges([
    ['c-intro'],
    ['c-setup'],
    ['c-core'],
  ]);
  expect(orderEdges).toHaveLength(2);
  expect(orderEdges[0].sourceId).toBe('c-intro');
  expect(orderEdges[0].targetId).toBe('c-setup');
  expect(orderEdges[1].sourceId).toBe('c-setup');
  expect(orderEdges[1].targetId).toBe('c-core');
});

test('computeConceptDepths：链式传播，related 边不参与', () => {
  const depths = computeConceptDepths(
    ['a', 'b', 'c', 'x', 'y'],
    [
      { sourceId: 'a', targetId: 'b', type: 'successor', weight: 0.3 },
      { sourceId: 'b', targetId: 'c', type: 'successor', weight: 0.3 },
      { sourceId: 'x', targetId: 'y', type: 'related', weight: 0.5 },
    ],
    4
  );
  expect(depths.get('c')).toBe(0);
  expect(depths.get('b')).toBe(1);
  expect(depths.get('a')).toBe(2);
  expect(depths.get('x')).toBe(0);
});

test('formatDependencyHintText：空依赖空串；有依赖含头部/归因/Address', () => {
  expect(formatDependencyHintText('目标', [])).toBe('');
  const hintText = formatDependencyHintText(
    '目标概念',
    [{ conceptName: '前置一', category: 'workflow', docPath: 'book/a.md', address: 'book/a.md#前置一' }],
    'owner/repo'
  );
  expect(hintText).toContain(CONCEPT_DEPENDENCY_HINT_HEADER);
  expect(hintText).toContain('[Source: owner/repo]');
  expect(hintText).toContain('book/a.md#前置一');
});

test('formatConceptTaxonomyGrouped：分组 + 深层前置在前 + 缩进标注', () => {
  const text = formatConceptTaxonomyGrouped([
    { conceptName: '顶层概念', category: 'architecture', docPath: null, address: null, depth: 0 },
    { conceptName: '底层前置', category: 'architecture', docPath: 'book/a.md', address: 'book/a.md#底层前置', depth: 2 },
    { conceptName: '流程概念', category: 'workflow', docPath: null, address: null, depth: 0 },
  ]);
  expect(text).toContain('### 🗂️ architecture');
  expect(text).toContain('### 🗂️ workflow');
  expect(text.indexOf('底层前置')).toBeLessThan(text.indexOf('顶层概念'));
  expect(text).toContain('[前置×2]');
  expect(text).toContain('book/a.md#底层前置');
});

test('extractConceptsFromMarkdown：无标题块序号去重 + anchorText 兜底', () => {
  const md = `这里是无标题块的开头段落，讲解系统设计的基本思路。
继续补充内容。

## 事件循环
事件循环是核心机制。

# 
中间还有一个无标题段落，作为第二个无标题块。`;
  const extracted = extractConceptsFromMarkdown(md, 'docs/test.md');
  expect(extracted).toHaveLength(3);
  expect(extracted[0].conceptName).toBe('概述设计');
  expect(extracted[0].anchorText).toBe('这里是无标题块的开头段落，讲解系统设计的基本思路。');
  expect(extracted[0].sourceHeading).toBeUndefined();
  expect(extracted[1].conceptName).toBe('事件循环');
  expect(extracted[1].sourceHeading).toBe('事件循环');
  expect(extracted[2].conceptName).toBe('概述设计 2');
  expect(extracted[2].anchorText).toBe('中间还有一个无标题段落，作为第二个无标题块。');
});

test('computeRepoEdgeCap：保底 / 封顶 / 单调', () => {
  expect(computeRepoEdgeCap(0, 0)).toBe(500);
  expect(computeRepoEdgeCap(10, 5)).toBe(500);
  expect(computeRepoEdgeCap(100, 50)).toBe(1600);
  expect(computeRepoEdgeCap(1000, 500)).toBe(4000);
  expect(computeRepoEdgeCap(50, 10)).toBeLessThanOrEqual(computeRepoEdgeCap(100, 20));
});

test('extractConceptsFromMarkdown：围栏内 # 注释不当标题', () => {
  const codeMd = `## 真正的标题

\`\`\`python
# 这是一条注释，不是标题
def foo():
    pass
\`\`\`

后续内容。`;
  const extracted = extractConceptsFromMarkdown(codeMd, 'docs/code.md');
  expect(extracted.some((c) => c.conceptName === '真正的标题')).toBe(true);
  expect(extracted.some((c) => c.conceptName === '这是一条注释，不是标题')).toBe(false);
});

test('extractConceptsFromMarkdown：反思行块级隔离（不污染其他概念）', () => {
  const md = `## 概念甲
这是概念甲的内容。
作者思考：甲的设计哲学是 X。

## 概念乙
这是概念乙的内容，没有反思行。`;
  const extracted = extractConceptsFromMarkdown(md, 'docs/refl.md');
  expect(extracted.find((c) => c.conceptName === '概念甲')?.authorReflections).toContain('设计哲学是 X');
  expect(extracted.find((c) => c.conceptName === '概念乙')?.authorReflections).toBeFalsy();
});

test('matchChunkAnchor：精确 / 后缀（代码章节）/ 未命中', () => {
  const codeChunks = [
    { id: 'ov', heading: 'Recursion > 概览', headingPath: 'core > overview' },
    { id: 's1', heading: 'Recursion > Base Case', headingPath: 'core > index.ts > baseCase' },
  ];
  const hit = matchChunkAnchor(codeChunks, 'Base Case');
  expect(hit?.id).toBe('s1');
  expect(hit?.headingPath).toBe('core > index.ts > baseCase');
  const exact = matchChunkAnchor([{ id: 'd1', heading: '事件循环', headingPath: 'doc > 事件循环' }], '事件循环');
  expect(exact?.id).toBe('d1');
  expect(matchChunkAnchor(codeChunks, '不存在')).toBeNull();
});

test('extractConceptsFromMarkdown：通用章务标题停用（简介/总结/Summary/编号引言不入图）', () => {
  const md = `## 事件循环
事件循环是核心机制。

## 简介
本教程将介绍事件循环。

## Summary
总结全文。

## 1. 引言
编号引言也会被归一化后命中停用词。`;
  const extracted = extractConceptsFromMarkdown(md, 'docs/stop.md');
  const names = extracted.map((c) => c.conceptName);
  expect(names).toContain('事件循环');
  expect(names).not.toContain('简介');
  expect(names).not.toContain('Summary');
  expect(names).not.toContain('引言');
  // 真正的概念不受停用词影响
  expect(extracted.find((c) => c.conceptName === '事件循环')?.sourceHeading).toBe('事件循环');
});
