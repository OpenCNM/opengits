import { test, expect, describe, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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
  prioritizeEdgesForBudget,
  type DerivedEdge,
} from '@/lib/mcp/concept-graph';
import {
  extractConceptsFromMarkdown,
  matchChunkAnchor,
  slugifyConcept,
  normalizeHeadingKey,
  MAX_CONCEPTS_PER_DOC,
  resolveConceptChunkAnchor,
} from '@/lib/mcp/concept-extractor';
import { planCanonicalGroups, canonicalFieldsFor } from '@/lib/mcp/concept-canonical';
import { buildCleanSectionAddress, parseSectionAddress } from '@/lib/mcp/section-address';
import { parseScopedConcept, runExploreConcept } from '@/lib/mcp/tools/concepts';
import { parseSuperTopicsBlock } from '@/lib/mcp/graph-condense';
import { flattenNavTreeEntries } from '@/lib/outline-reader';

describe('concept-graph', () => {
  test('filterPrerequisiteCandidates：矛盾边/传递成环边丢弃，related/part_of 不参与校验', () => {
    const established = [
      { sourceId: 'b', targetId: 'c', type: 'successor', weight: 0.3 },
      { sourceId: 'c', targetId: 'a', type: 'successor', weight: 0.3 },
    ];
    const { kept, dropped } = filterPrerequisiteCandidates(
      [
        { sourceId: 'c', targetId: 'b', type: 'prerequisite', weight: 0.5, source: 'llm_extracted' },
        { sourceId: 'a', targetId: 'b', type: 'prerequisite', weight: 0.5, source: 'llm_extracted' },
        { sourceId: 'b', targetId: 'd', type: 'prerequisite', weight: 0.5, source: 'llm_extracted' },
      ],
      established
    );
    expect(dropped).toBe(2);
    expect(kept.map((k) => `${k.sourceId}->${k.targetId}`)).toEqual(['b->d']);

    const nonPrereq = filterPrerequisiteCandidates(
      [
        { sourceId: 'c', targetId: 'b', type: 'related', weight: 0.5, source: 'llm_extracted' },
        { sourceId: 'b', targetId: 'c', type: 'part_of', weight: 0.5, source: 'llm_extracted' },
      ],
      [{ sourceId: 'b', targetId: 'c', type: 'successor', weight: 0.3 }]
    );
    expect(nonPrereq.dropped).toBe(0);
    expect(nonPrereq.kept).toHaveLength(2);
  });

  test('deriveCooccurrenceEdges & deriveCurriculumOrderEdges：同 Chunk 共现与教学线性化前驱边', () => {
    const cooc = deriveCooccurrenceEdges([
      { id: 'a', documentId: 'doc1', chunkId: 'chunk1' },
      { id: 'b', documentId: 'doc1', chunkId: 'chunk1' },
      { id: 'c', documentId: 'doc1', chunkId: 'chunk2' },
      { id: 'd', documentId: 'doc2', chunkId: null },
      { id: 'e', documentId: null, chunkId: null },
    ]);
    expect(cooc).toHaveLength(1);
    expect(cooc[0]).toMatchObject({ sourceId: 'a', targetId: 'b', weight: 1.0, type: 'related', meta: { chunkId: 'chunk1' } });

    const curr = deriveCurriculumOrderEdges([['a', 'b'], ['c'], ['d', 'e']]);
    expect(curr).toHaveLength(3);
    expect(curr.every((e) => e.type === 'successor' && e.source === 'curriculum_order')).toBe(true);
    expect(new Set(curr.map((e) => e.targetId))).toEqual(new Set(['c', 'd', 'e']));

    const incr = deriveCurriculumOrderEdges([['prev1'], ['this1', 'this2']]);
    expect(incr).toHaveLength(2);
    expect(incr.every((e) => e.sourceId === 'prev1')).toBe(true);
  });

  test('computeNeighborMap / computeLearningPathChain / computeConceptDepths 图遍历与深度传播', () => {
    const edges = [
      { sourceId: 'a', targetId: 'b', type: 'successor', weight: 0.3 },
      { sourceId: 'b', targetId: 'c', type: 'successor', weight: 0.3 },
      { sourceId: 'a', targetId: 'c', type: 'related', weight: 0.5 },
    ];
    const map = computeNeighborMap(edges);
    expect(map.get('a')!.outgoing).toHaveLength(2);
    expect(map.get('a')!.incoming).toHaveLength(0);
    expect(map.get('c')!.incoming).toHaveLength(2);

    const chain = computeLearningPathChain('c', edges, 4);
    expect(chain).toHaveLength(2);
    expect(chain.some((s) => s.conceptId === 'a' && s.depth === 2)).toBe(true);
    expect(chain.some((s) => s.conceptId === 'b' && s.depth === 1)).toBe(true);

    const depths = computeConceptDepths(
      ['a', 'b', 'c', 'x', 'y'],
      [
        { sourceId: 'a', targetId: 'b', type: 'successor', weight: 0.3 },
        { sourceId: 'b', targetId: 'c', type: 'successor', weight: 0.3 },
        { sourceId: 'x', targetId: 'y', type: 'related', weight: 0.5 },
      ],
      4
    );
    expect([depths.get('c'), depths.get('b'), depths.get('a'), depths.get('x')]).toEqual([0, 1, 2, 0]);
  });

  test('图谱格式化与关系标签：learningPath / neighbors / dependencyHint / taxonomyGrouped', () => {
    const lpText = formatLearningPathOutput('目标概念', [
      { conceptId: 'x', conceptName: '前置一', canonicalKey: null, canonicalName: null, category: 'workflow', depth: 1, docPath: 'book/a.md', headingPath: '前置一', address: 'book/a.md#前置一' },
    ]);
    expect(lpText).toContain('🎯 目标概念');
    expect(lpText).toContain('[Address: book/a.md#前置一]');

    const nbRelated = formatNeighborsOutput('目标概念', [
      { conceptId: 'y', conceptName: '邻居一', canonicalKey: null, canonicalName: null, category: 'reflection', docPath: 'book/b.md', headingPath: '邻居一', address: 'book/b.md#邻居一', relation: { direction: 'incoming', type: 'related', weight: 0.5, source: 'cooccurrence' }, edgeCount: 1 },
    ]);
    expect(nbRelated).toContain('⇋[相关]');

    const nbPrereq = formatNeighborsOutput('目标概念', [
      { conceptId: 'p', conceptName: '前置概念', canonicalKey: null, canonicalName: null, category: 'architecture', docPath: 'book/p.md', headingPath: '前置', address: 'book/p.md#前置', relation: { direction: 'incoming', type: 'prerequisite', weight: 0.6, source: 'code_dep' }, edgeCount: 1 },
    ]);
    expect(nbPrereq).toContain('⇠[前置]');
    expect(nbPrereq).toContain('w0.60');

    expect(neighborRelationTag({ type: 'prerequisite', direction: 'incoming' })).toBe('⇠[前置]');
    expect(neighborRelationTag({ type: 'prerequisite', direction: 'outgoing' })).toBe('⇢[后学]');
    expect(neighborRelationTag({ type: 'successor', direction: 'incoming' })).toBe('⇠[先学]');
    expect(neighborRelationTag({ type: 'successor', direction: 'outgoing' })).toBe('⇢[后继]');
    expect(neighborRelationTag({ type: 'part_of', direction: 'incoming' })).toBe('⇠[组成部分]');
    expect(neighborRelationTag({ type: 'co_located', direction: 'undirected' })).toBe('⇋[同篇]');
    expect(neighborRelationTag({ type: 'related', direction: 'outgoing' })).toBe('⇋[相关]');

    expect(formatDependencyHintText('目标', [])).toBe('');
    const hintText = formatDependencyHintText(
      '目标概念',
      [{ conceptName: '前置一', category: 'workflow', docPath: 'book/a.md', address: 'book/a.md#前置一' }],
      'owner/repo'
    );
    expect(hintText).toContain(CONCEPT_DEPENDENCY_HINT_HEADER);
    expect(hintText).toContain('[Source: owner/repo]');

    const tax = formatConceptTaxonomyGrouped([
      { conceptName: '顶层概念', category: 'architecture', docPath: null, address: null, depth: 0 },
      { conceptName: '底层前置', category: 'architecture', docPath: 'book/a.md', address: 'book/a.md#底层前置', depth: 2 },
      { conceptName: '流程概念', category: 'workflow', docPath: null, address: null, depth: 0 },
    ]);
    expect(tax).toContain('### 🗂️ architecture');
    expect(tax.indexOf('底层前置')).toBeLessThan(tax.indexOf('顶层概念'));
    expect(tax).toContain('[前置×2]');
  });

  test('Schema 唯一键/级联与 navTree 展平边序一致性', () => {
    const schemaContent = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf-8');
    const edgeBlock = schemaContent.match(/model TutorialConceptEdge\s*\{[\s\S]*?\n\}/)![0];
    expect(edgeBlock).toMatch(/@@unique\(\[sourceId,\s*targetId,\s*type\]\)/);
    expect(edgeBlock).toMatch(/onDelete:\s*Cascade/);

    const goStoreContent = fs.readFileSync(path.join(process.cwd(), 'services/worker-sidecar/internal/userinteraction/store_concept_graph.go'), 'utf-8');
    expect(goStoreContent).toContain('ON CONFLICT ("sourceId", "targetId", "type") DO NOTHING');

    const files = flattenNavTreeEntries([
      {
        name: 'part1',
        title: '第 1 部分',
        type: 'directory',
        path: 'part1',
        children: [
          { name: 'intro.md', title: '介绍', type: 'file', path: 'part1/intro.md' },
          { name: 'setup.md', title: '安装', type: 'file', path: 'part1/setup.md' },
        ],
      },
      { name: 'part2', title: '第 2 部分', type: 'directory', path: 'part2', children: [{ name: 'core.md', title: '核心', type: 'file', path: 'part2/core.md' }] },
    ] as never).map((e) => e.path);
    expect(files).toEqual(['part1/intro.md', 'part1/setup.md', 'part2/core.md']);
  });
});

describe('concept-canonical & edge-budget', () => {
  const edge = (sourceId: string, targetId: string, weight = 0.5): DerivedEdge => {
    const [s, t] = [sourceId, targetId].sort();
    return { sourceId: s, targetId: t, type: 'related', weight, source: 'cooccurrence' };
  };
  const curriculum = (sourceId: string, targetId: string): DerivedEdge => ({
    sourceId,
    targetId,
    type: 'successor',
    weight: 0.3,
    source: 'curriculum_order',
  });

  test('planCanonicalGroups & canonicalFieldsFor 归一分组、同频字典序与空 key 语义', () => {
    const plans = planCanonicalGroups([
      { id: 'a', conceptName: '事件循环' },
      { id: 'b', conceptName: '事件循环' },
      { id: 'c', conceptName: '1. 事件循环' },
      { id: 'd', conceptName: 'Event Loop' },
    ]);
    expect(plans.size).toBe(2);
    expect(plans.get('事件循环')!.memberIds).toEqual(['a', 'b', 'c']);
    expect(plans.get('event loop')!.memberIds).toEqual(['d']);

    const tie = planCanonicalGroups([
      { id: 'x', conceptName: 'Beta 名称' },
      { id: 'y', conceptName: 'Alpha 名称' },
    ]);
    expect(tie.get('alpha 名称')!.canonicalName).toBe('Alpha 名称');
    expect(planCanonicalGroups([{ id: 'a', conceptName: '1. ' }, { id: 'b', conceptName: '   ' }]).size).toBe(0);
    expect(canonicalFieldsFor('  Event Loop  ')).toEqual({ canonicalKey: 'event loop', canonicalName: 'Event Loop' });
    expect(canonicalFieldsFor('1. ')).toEqual({ canonicalKey: null, canonicalName: '1.' });
  });

  test('prioritizeEdgesForBudget & computeRepoEdgeCap 预算截断、长尾优先与区间夹紧', () => {
    const res1 = prioritizeEdgesForBudget(
      [curriculum('a', 'b'), curriculum('b', 'c'), curriculum('c', 'd')],
      Array.from({ length: 20 }, (_, i) => edge(`n${i}`, `n${i + 1}`)),
      5
    );
    expect(res1.filter((e) => e.source === 'curriculum_order')).toHaveLength(3);
    expect(res1).toHaveLength(5);

    const hubEdges = Array.from({ length: 8 }, (_, i) => edge('hub', `leaf${i}`));
    const resTail = prioritizeEdgesForBudget([], [...hubEdges, edge('tail-a', 'tail-b')], 1);
    expect(resTail.map((e) => `${e.sourceId}:${e.targetId}`)).toEqual(['tail-a:tail-b']);

    expect(prioritizeEdgesForBudget([curriculum('a', 'b')], [], 0)).toEqual([]);
    expect(computeRepoEdgeCap(0, 0)).toBe(500);
    expect(computeRepoEdgeCap(100, 50)).toBe(1600);
    expect(computeRepoEdgeCap(100000, 5000)).toBe(4000);
    expect(computeRepoEdgeCap(100, 30)).toBeLessThan(computeRepoEdgeCap(200, 30));
  });
});

describe('concept-extractor & scoped-parsing & graph-condense', () => {
  test('extractConceptsFromMarkdown：无标题去重/围栏注释隔离/反思隔离/停用词/长度截断', () => {
    const untitled = extractConceptsFromMarkdown(
      '这里是无标题块的开头段落，讲解系统设计的基本思路。\n\n## 事件循环\n这是事件循环核心机制的详细正文说明。\n\n# \n第二个无标题段落。',
      'docs/test.md'
    );
    expect(untitled.map((c) => c.conceptName)).toEqual(['概述设计', '事件循环', '概述设计 2']);

    const fenced = extractConceptsFromMarkdown('## 真正的标题\n\n```python\n# 这是一条注释，不是标题\ndef foo(): pass\n```', 'docs/code.md');
    expect(fenced.some((c) => c.conceptName === '真正的标题')).toBe(true);
    expect(fenced.some((c) => c.conceptName === '这是一条注释，不是标题')).toBe(false);

    const refl = extractConceptsFromMarkdown('## 概念甲\n正文。\n作者思考：设计哲学是 X。\n\n## 概念乙\n无反思。', 'docs/refl.md');
    expect(refl.find((c) => c.conceptName === '概念甲')?.authorReflections).toContain('设计哲学是 X');
    expect(refl.find((c) => c.conceptName === '概念乙')?.authorReflections).toBeFalsy();

    const stop = extractConceptsFromMarkdown(
      '## 事件循环\n这是事件循环调度机制的详细正文说明。\n\n## 简介\n这是章节简介与概览的详细正文内容。\n\n## Summary\nThis is a detailed summary paragraph.\n\n## 1. 引言\n这是引言部分的详细背景描述内容。',
      'docs/stop.md'
    );
    expect(stop.map((c) => c.conceptName)).toEqual(['事件循环']);

    const longHeading = '## A Very Long Architecture Design Concept Heading That Contains More Than Eighty Characters In A Single Line For Test';
    const clamped = extractConceptsFromMarkdown(`${longHeading}\n\nHere are architectural insights.\n`, 'docs/arch.md');
    expect(clamped[0].conceptName.length).toBe(60);

    const headings22 = Array.from({ length: 22 }, (_, i) => `## 概念章节 ${i + 1}\n这是用于验证章节截断的详细正文描述段落，字数超过六十个字符以满足信息密度阈值过滤要求 ${i + 1}`).join('\n\n');
    expect(extractConceptsFromMarkdown(headings22, 'docs/long.md')).toHaveLength(MAX_CONCEPTS_PER_DOC);
  });

  test('extractConceptsFromMarkdown AST 结构分类与低密度过滤', () => {
    const md = `## 用户认证流程\n1. 校验 Token\n2. 读取数据库\n\n## 虚拟 DOM 核心原理\n\`\`\`ts\nfunction diff(a, b) {}\n\`\`\`\n\n## 架构演进与设计权衡\n> Trade-off 在于零成本抽象。\n\n## 基础设施配置\n纯架构配置与目录结构说明，包含了基础微服务的部署拓扑，网络网关路由分发规则与跨可用区高可用容灾设计方案。`;
    const concepts = extractConceptsFromMarkdown(md, 'docs/guide.md');
    expect(concepts.map((c) => c.category)).toEqual(['workflow', 'principle', 'reflection', 'architecture']);

    const filtered = extractConceptsFromMarkdown(
      '## 核心微服务架构\n这是一个非常完整的系统架构描述，详细记录了各微服务之间的通信拓扑与高可用部署设计方案。\n\n## 总结\n本章完。\n\n## 参考文献\n详见链接。',
      'docs/arch.md'
    );
    expect(filtered.map((c) => c.conceptName)).toEqual(['核心微服务架构']);
  });

  test('slugifyConcept / normalizeHeadingKey / matchChunkAnchor / resolveConceptChunkAnchor 鲁棒性', () => {
    expect(slugifyConcept('React 19 事件循环原理')).toBe('react-19-事件循环原理');
    expect(slugifyConcept('C++ & Rust: 内存安全 @ 2026!')).toBe('c-rust-内存安全-2026');
    expect(slugifyConcept('')).toMatch(/^concept-\d+$/);

    for (const [raw, expected] of [
      ['## **加粗重要章节**', '加粗重要章节'],
      ['01_architecture', 'architecture'],
      ['1.2.3 核心组件', '核心组件'],
      ['(1) 核心组件', '核心组件'],
      ['## .NET Core 运行机制', '.net core 运行机制'],
    ]) {
      expect(normalizeHeadingKey(raw), raw).toBe(expected);
    }

    const chunks = [
      { id: 'chunk-1', heading: '核心架构机制', headingPath: '系统概览 > 核心架构机制' },
      { id: 'chunk-2', heading: 'Chapter 1 > 状态机设计', headingPath: 'Chapter 1 > 状态机设计' },
      { id: 'chunk-3', heading: 'Architecture Overview', headingPath: 'Architecture Overview' },
      { id: 'chunk-4', heading: 'Module A > 01_状态机设计', headingPath: 'Module A > 01_状态机设计' },
      { id: 'chunk-5', heading: 'AuthModule > 登录认证流程 (Part 1)', headingPath: 'AuthModule > 登录认证流程 (Part 1)' },
    ];
    expect(matchChunkAnchor(chunks, '## **核心架构机制**')?.id).toBe('chunk-1');
    expect(matchChunkAnchor(chunks, '状态机设计')?.id).toBe('chunk-2');
    expect(matchChunkAnchor(chunks, '01_architecture_overview')?.id).toBe('chunk-3');
    expect(matchChunkAnchor([chunks[3]], '状态机设计')?.id).toBe('chunk-4');
    expect(matchChunkAnchor([chunks[4]], '登录认证流程')?.id).toBe('chunk-5');
    expect(matchChunkAnchor(chunks, '不存在')).toBeNull();

    const emptyAnchor = resolveConceptChunkAnchor(
      { conceptName: 'Event Loop', slug: 'event-loop', category: 'workflow', principlesText: 'p', sopSteps: [], summary: 's', subTopics: [], tags: [], sourceHeading: 'Missing' },
      []
    );
    expect(emptyAnchor.chunkId).toBeNull();
    expect(parseSectionAddress(buildCleanSectionAddress('docs/tutorial', emptyAnchor.headingPath))).toEqual({
      docPath: 'docs/tutorial',
      headingPath: '',
    });
  });

  test('parseScopedConcept / runExploreConcept / parseSuperTopicsBlock', async () => {
    expect(parseScopedConcept('facebook/react#Hooks')).toEqual({ scope: 'facebook/react', conceptName: 'Hooks' });
    expect(parseScopedConcept('   vercel/turborepo # Pipeline Caching   ')).toEqual({ scope: 'vercel/turborepo', conceptName: 'Pipeline Caching' });
    expect(parseScopedConcept('org/repo#module#subconcept')).toEqual({ scope: 'org/repo#module', conceptName: 'subconcept' });
    expect(parseScopedConcept('   ')).toEqual({ scope: '', conceptName: '' });

    const emptyRes = await runExploreConcept({ concept: '   ' }, { owner: 'o', repo: 'r', multiRepo: false } as any);
    expect(emptyRes.isError).toBe(true);

    const resolveRepository = vi.fn().mockResolvedValue(null);
    const scopedRes = await runExploreConcept(
      { concept: 'nonexistent/repo#SomeConcept' },
      { label: 'Hub', owner: 'o', repo: 'r', multiRepo: true, userId: 'u1', resolveRepository } as any
    );
    expect(scopedRes.isError).toBe(true);
    expect(resolveRepository).toHaveBeenCalledWith('nonexistent/repo');

    expect(
      parseSuperTopicsBlock({
        conceptSuperTopics: { topics: [{ title: 'JS 异步模型', summary: 's', memberKeys: ['k1'] }], generatedAt: '2026-08-29T00:00:00.000Z', model: 'openai/gpt-x' },
      })?.topics
    ).toHaveLength(1);
    expect(parseSuperTopicsBlock(undefined)).toBeNull();
    expect(parseSuperTopicsBlock({ conceptSuperTopics: { nope: true } })).toBeNull();
  });
});
