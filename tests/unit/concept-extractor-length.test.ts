import { describe, it, expect } from 'vitest';
import {
  extractConceptsFromMarkdown,
  matchChunkAnchor,
  resolveConceptChunkAnchor,
} from '@/lib/mcp/concept-extractor';
import {
  buildCleanSectionAddress,
  parseSectionAddress,
} from '@/lib/mcp/section-address';

describe('Concept Extractor Title Length Clamping (A4) & Anchor Fallbacks', () => {
  it('🧪 [4.1.1.1] clamps an 80+ character heading to <= 60 characters without ellipsis and collapses spaces', () => {
    const longHeading = '## A Very Long Architecture Design Concept Heading That Contains More Than Eighty Characters In A Single Line For Test';
    const content = `${longHeading}\n\nHere are some architectural principles and insights about the system.\n`;

    const concepts = extractConceptsFromMarkdown(content, 'docs/arch.md');
    expect(concepts).toHaveLength(1);
    expect(concepts[0].conceptName.length).toBeLessThanOrEqual(60);
    expect(concepts[0].conceptName).toBe(
      'A Very Long Architecture Design Concept Heading That Contain'
    );
    expect(concepts[0].conceptName.length).toBe(60);
  });

  it('preserves short headings as-is without modification', () => {
    const shortHeading = '## State Management';
    const content = `${shortHeading}\n\nPrinciples of state management in client-side reactive architectures and store subscriptions.\n`;

    const concepts = extractConceptsFromMarkdown(content, 'docs/state.md');
    expect(concepts).toHaveLength(1);
    expect(concepts[0].conceptName).toBe('State Management');
  });

  it('🧪 [4.1.3.1] 概念对应章节被重构删除后锚点平滑导航至教程首页（防死链崩溃）', () => {
    const concept = {
      conceptName: 'Event Loop',
      slug: 'event-loop',
      category: 'workflow' as const,
      principlesText: 'Understanding async event execution loop',
      sopSteps: [],
      summary: 'Event loop summary',
      subTopics: [],
      tags: [],
      sourceHeading: 'Chapter 2: Event Loop Runtime',
    };

    // 章节被重构删除后，关联的 chunks 集合为空或已不存在
    const emptyChunks: Array<{ id: string; heading: string | null; headingPath: string | null; content: string }> = [];

    // 锚点反查安全返回 null，绝不抛出未捕获异常
    const directMatch = matchChunkAnchor(emptyChunks, concept.sourceHeading);
    expect(directMatch).toBeNull();

    const anchorResult = resolveConceptChunkAnchor(concept, emptyChunks);
    expect(anchorResult.chunkId).toBeNull();
    expect(anchorResult.headingPath).toBeNull();
    // 依然保留概念自身的 principlesText 与定义，保障无死链与零崩溃
    expect(anchorResult.principlesText).toBe(concept.principlesText);

    // 使用标准 section-address 解析：当 headingPath 为空/重构删除时，平滑降级到文档首页
    const address = buildCleanSectionAddress('docs/tutorial', anchorResult.headingPath);
    expect(address).toBe('docs/tutorial#');
    const parsed = parseSectionAddress(address);
    expect(parsed.docPath).toBe('docs/tutorial');
    expect(parsed.headingPath).toBe('');
  });
});
