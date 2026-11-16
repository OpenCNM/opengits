import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractConceptsFromMarkdown,
  MAX_CONCEPTS_PER_DOC,
} from '@/lib/mcp/concept-extractor';
import {
  getConceptGrounding,
} from '@/lib/mcp/concept-graph/concept-queries';
import {
  injectConceptMentorCard,
  CONCEPT_MENTOR_CARD_HEADER,
} from '@/lib/mcp/doc-search';

// Mock DB
const repoFindUniqueMock = vi.fn();
const conceptFindManyMock = vi.fn();
const conceptFindFirstMock = vi.fn();
const edgeFindManyMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findUnique: (...args: unknown[]) => repoFindUniqueMock(...args),
    },
    tutorialConceptNode: {
      findMany: (...args: unknown[]) => conceptFindManyMock(...args),
      findFirst: (...args: unknown[]) => conceptFindFirstMock(...args),
    },
    tutorialConceptEdge: {
      findMany: (...args: unknown[]) => edgeFindManyMock(...args),
    },
  },
}));

// Mock graph-store
const loadSemanticGraphArtifactMock = vi.fn();
vi.mock('@/engine/ingest/graph-store', () => ({
  loadSemanticGraphArtifact: (...args: unknown[]) => loadSemanticGraphArtifactMock(...args),
}));

describe('知识图谱 (Agent Cognitive Graph) 第一性原理单元测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. 源头控熵：概念提取上限与低密度过滤', () => {
    it('单文档提取概念严格受控于 MAX_CONCEPTS_PER_DOC (5 个)，防止大仓无序膨胀', () => {
      const doc = Array.from({ length: 12 }, (_, i) => 
        `## 架构核心模型 ${i + 1}\n这是具有实质性架构定义的正文段落，包含了模块核心职责、数据流向以及状态流转机制说明 ${i + 1}。`
      ).join('\n\n');

      const concepts = extractConceptsFromMarkdown(doc, 'docs/architecture.md');
      expect(concepts.length).toBeLessThanOrEqual(MAX_CONCEPTS_PER_DOC);
      expect(concepts.length).toBe(MAX_CONCEPTS_PER_DOC);
      expect(concepts[0].conceptName).toBe('架构核心模型 1');
    });

    it('过滤短于 35 字符且无步骤/代码/反思的过场性标题', () => {
      const doc = `## 状态机调度引擎
这是具备完整说明的核心架构章节。包含事件驱动与原子转移机制。

## 下一步
进入下一节。

## 核心配置
这是关于全局参数与持久化缓存的完整配置规范说明。`;

      const concepts = extractConceptsFromMarkdown(doc, 'docs/statemachine.md');
      expect(concepts).toHaveLength(2);
      expect(concepts.map((c) => c.conceptName)).toEqual(['状态机调度引擎', '核心配置']);
    });
  });

  describe('2. 双图贯通：RSG AST 黄金符号与 PageRank 主干文件穿透 (getConceptGrounding)', () => {
    it('当存在 RSG 产物时，成功桥接 Golden Symbols 与 Backbone Files', async () => {
      repoFindUniqueMock.mockResolvedValueOnce({
        owner: 'test-org',
        repo: 'test-repo',
        gitSha: 'sha-123456',
        repoProfile: {},
      });

      loadSemanticGraphArtifactMock.mockResolvedValueOnce({
        version: 2,
        goldenSymbols: [
          { file: 'src/parser/ast.ts', name: 'parseAST', kind: 'function', score: 0.95, importers: 12 },
          { file: 'src/parser/ast.ts', name: 'ASTNode', kind: 'type', score: 0.88, importers: 10 },
          { file: 'src/utils/logger.ts', name: 'log', kind: 'function', score: 0.1, importers: 1 },
        ],
        nodes: [
          { path: 'src/parser/ast.ts', role: 'core_contract', pageRank: 0.145, isBackbone: true },
          { path: 'src/index.ts', role: 'entry_point', pageRank: 0.095, isBackbone: true },
        ],
      });

      const grounding = await getConceptGrounding('repo-1', 'parseAST 语法解析');
      expect(grounding).not.toBeNull();
      expect(grounding?.goldenSymbols).toHaveLength(2);
      expect(grounding?.goldenSymbols[0].name).toBe('parseAST');
      expect(grounding?.goldenSymbols[0].kind).toBe('function');
      expect(grounding?.goldenSymbols[0].score).toBe(0.95);
      expect(grounding?.goldenSymbols[1].name).toBe('ASTNode');
      expect(grounding?.goldenSymbols[1].kind).toBe('type');

      expect(grounding?.backboneFiles).toHaveLength(2);
      expect(grounding?.backboneFiles[0].path).toBe('src/parser/ast.ts');
      expect(grounding?.backboneFiles[0].role).toBe('core_contract');
    });

    it('当仓库无 gitSha 或无 RSG 产物时，优雅降级返回 null（零错误）', async () => {
      repoFindUniqueMock.mockResolvedValueOnce({
        owner: 'test-org',
        repo: 'test-repo',
        gitSha: null,
      });

      const grounding = await getConceptGrounding('repo-2', 'Virtual DOM');
      expect(grounding).toBeNull();
    });
  });

  describe('3. 智能体搜索卡片升级：AST 符号与代码文件注入 (injectConceptMentorCard)', () => {
    it('当存在代码 Grounding 时，导师卡片呈现黄金符号与主干文件', async () => {
      conceptFindFirstMock.mockResolvedValueOnce({
        id: 'concept-1',
        conceptName: '事件循环机制',
        category: 'architecture',
        headingPath: 'event-loop',
        document: { path: 'chapters/02.md', title: '异步运行时' },
        authorReflections: '微任务与宏任务的权衡。',
        sopSteps: ['创建任务队列', '执行微任务', '执行渲染'],
        summary: '基于事件驱动的单线程并发模型',
      });

      repoFindUniqueMock.mockResolvedValueOnce({
        owner: 'runtime',
        repo: 'engine',
        gitSha: 'sha-abc',
      });

      loadSemanticGraphArtifactMock.mockResolvedValueOnce({
        version: 2,
        goldenSymbols: [
          { file: 'src/loop.ts', name: 'runEventLoop', kind: 'function', score: 0.92, importers: 15 },
        ],
        nodes: [
          { path: 'src/loop.ts', role: 'core_contract', pageRank: 0.18, isBackbone: true },
        ],
      });

      const baseText = 'Search hits for query:\n- hit 1';
      const card = await injectConceptMentorCard('repo-runtime', '事件循环机制', baseText);

      expect(card).toContain(CONCEPT_MENTOR_CARD_HEADER);
      expect(card).toContain('**核心概念**: 事件循环机制 (architecture)');
      expect(card).toContain('**作者思考与 Trade-off 权衡**');
      expect(card).toContain('**核心 SOP 开发步骤**');
      // AST 黄金符号与主干文件段落
      expect(card).toContain('**核心代码符号 (AST Golden Symbols)**:');
      expect(card).toContain('`runEventLoop` (function) in `src/loop.ts`');
      expect(card).toContain('**主干实现文件**:');
      expect(card).toContain('`src/loop.ts` (core_contract)');
    });
  });

});
