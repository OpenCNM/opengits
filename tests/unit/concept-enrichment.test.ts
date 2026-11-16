import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  matchConceptNode,
  injectConceptMentorCard,
  injectConceptDependencyHint,
  injectConceptEnrichments,
  CONCEPT_MENTOR_CARD_HEADER,
} from '@/lib/mcp/doc-search';

const conceptFindFirstMock = vi.fn();
const conceptFindManyMock = vi.fn();
const conceptFindUniqueMock = vi.fn();
const getConceptDependenciesMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    tutorialConceptNode: {
      findFirst: (...args: unknown[]) => conceptFindFirstMock(...args),
      findMany: (...args: unknown[]) => conceptFindManyMock(...args),
      findUnique: (...args: unknown[]) => conceptFindUniqueMock(...args),
    },
  },
}));

vi.mock('@/lib/mcp/concept-graph', () => ({
  getConceptDependencies: (...args: unknown[]) => getConceptDependenciesMock(...args),
  getConceptGrounding: vi.fn().mockResolvedValue(null),
  formatDependencyHintText: (conceptName: string, deps: any[], sourceLabel?: string) =>
    `\n\n⚡ 学习路径依赖提示 [${conceptName}]: 前置知识 -> ${deps.map((d) => d.name).join(', ')}${sourceLabel ? ` [Source: ${sourceLabel}]` : ''}`,
  CONCEPT_DEPENDENCY_HINT_HEADER: '⚡ 学习路径与依赖提示',
}));

describe('Knowledge Graph 概念匹配与导师卡片/依赖提示富集测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('matchConceptNode：标准中文技术词精确命中 conceptName', async () => {
    const mockNode = {
      id: 'node-1',
      conceptName: '所有权',
      category: 'Core',
      summary: 'Rust 内存管理机制',
      document: { path: 'ch04-01-what-is-ownership.md', title: '认识所有权' },
    };
    conceptFindFirstMock.mockResolvedValueOnce(mockNode);

    const result = await matchConceptNode('repo-1', '所有权');
    expect(result).toEqual(mockNode);
    expect(conceptFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          repositoryId: 'repo-1',
        }),
      })
    );
  });

  it('matchConceptNode：标点分隔多词（所有权、借用）正确切词并命中', async () => {
    const mockNode = {
      id: 'node-2',
      conceptName: '借用',
      category: 'Core',
      summary: 'Rust 借用规则',
      document: { path: 'ch04-02-references.md', title: '引用与借用' },
    };
    // 第一次 nameAllNode 未命中，第二次 nameNode 命中
    conceptFindFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce(mockNode);

    const result = await matchConceptNode('repo-1', '所有权、借用');
    expect(result).toEqual(mockNode);
    expect(conceptFindFirstMock).toHaveBeenCalledTimes(2);
  });

  it('matchConceptNode：空查询或纯标点查询返回 null', async () => {
    const result1 = await matchConceptNode('repo-1', '');
    const result2 = await matchConceptNode('repo-1', '  ');
    const result3 = await matchConceptNode('repo-1', '!?@#');
    expect(result1).toBeNull();
    expect(result2).toBeNull();
    expect(result3).toBeNull();
  });

  it('injectConceptMentorCard：成功注入导师思考卡片与 Address 锚点', async () => {
    const mockNode = {
      id: 'node-3',
      conceptName: '生命周期',
      category: 'Advanced',
      headingPath: 'lifetime-syntax',
      document: { path: 'ch10-03-lifetime.md', title: '生命周期语法' },
      authorReflections: '生命周期的主要目的是避免悬垂引用。\n权衡是增加了编译期心智负担。',
      sopSteps: ['标注文档签名生命周期', '排查引用结构体生命周期约束'],
      summary: '生命周期是 Rust 借用检查器的核心保证',
    };
    conceptFindFirstMock.mockResolvedValueOnce(mockNode);

    const baseText = 'Search results for "生命周期" across rust-lang/rust [Locator Mode]:\n- Hit 1';
    const enriched = await injectConceptMentorCard('repo-1', '生命周期', baseText);

    expect(enriched).toContain(CONCEPT_MENTOR_CARD_HEADER);
    expect(enriched).toContain('**核心概念**: 生命周期 (Advanced)');
    expect(enriched).toContain('**来源**: ch10-03-lifetime.md [Address: ch10-03-lifetime.md#lifetime-syntax]');
    expect(enriched).toContain('**作者思考与 Trade-off 权衡**');
    expect(enriched).toContain('**核心 SOP 开发步骤**');
    expect(enriched).toContain('1. 标注文档签名生命周期');
    expect(enriched).toContain('**设计摘要**: 生命周期是 Rust 借用检查器的核心保证');
  });

  it('injectConceptEnrichments：一站式单次解析注入导师卡片与前置知识依赖', async () => {
    const mockNode = {
      id: 'node-4',
      conceptName: '智能指针',
      category: 'Pointers',
      headingPath: 'box-pointer',
      document: { path: 'ch15-01-box.md', title: 'Box<T>' },
      authorReflections: '堆内存分配与所有权语义结合。',
      sopSteps: ['使用 Box::new 创建堆上分配数据'],
      summary: '基础智能指针',
    };
    conceptFindFirstMock.mockResolvedValueOnce(mockNode);
    getConceptDependenciesMock.mockResolvedValueOnce([
      { id: 'dep-1', name: '所有权' },
      { id: 'dep-2', name: 'Deref Trait' },
    ]);

    const baseText = 'Hit: Box<T> Section';
    const result = await injectConceptEnrichments('repo-1', '智能指针', baseText, {
      sourceLabel: 'rust-lang/rust',
    });

    // 导师卡片
    expect(result).toContain(CONCEPT_MENTOR_CARD_HEADER);
    expect(result).toContain('智能指针 (Pointers)');
    // 依赖提示
    expect(result).toContain('⚡ 学习路径依赖提示 [智能指针]: 前置知识 -> 所有权, Deref Trait [Source: rust-lang/rust]');
  });
});
