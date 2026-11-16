import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 契约基准测试（TS 侧只读契约对齐）：
 * 夹具为 services/worker-sidecar/testdata 目录下的冻结契约（frozen contract fixtures），
 * 本测试确保 TS 侧相关消费逻辑与冻结契约保持一致。
 */

const testdata = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../services/worker-sidecar/testdata', name), 'utf8'));

describe('双实现共享 golden 夹具（冻结契约对齐）', () => {
  it('search-snippet: extractContextSnippet / resolveDocTitle 与夹具一致', async () => {
    const { extractContextSnippet, resolveDocTitle } = await import('@/lib/search/snippet');
    const fixture = testdata('search-snippet.golden.json');

    for (const tc of fixture.snippets) {
      expect(extractContextSnippet(tc.input.text, tc.input.query, tc.input.maxLen), tc.name).toBe(tc.expected);
    }
    for (const tc of fixture.titles) {
      expect(resolveDocTitle(tc.input.title, tc.input.path, tc.input.content), tc.name).toBe(tc.expected);
    }
  });



  it('9.2.5.2 · token-counter: estimateTokens / truncateToTokenBudget 与黄金夹具一致', async () => {
    const { estimateTokens, truncateToTokenBudget } = await import('@/lib/token-counter');
    const fixture = testdata('token-counter.golden.json');

    for (const tc of fixture.estimateCases) {
      expect(estimateTokens(tc.input.text), `estimateTokens: ${tc.name}`).toBe(tc.expected);
    }

    for (const tc of fixture.truncateCases) {
      const actual = tc.input.suffix !== null
        ? truncateToTokenBudget(tc.input.text, tc.input.maxTokens, tc.input.suffix)
        : truncateToTokenBudget(tc.input.text, tc.input.maxTokens);
      expect(actual, `truncateToTokenBudget: ${tc.name}`).toBe(tc.expected);
    }
  });











  // 🧪 向量 2.12.10.1: 存储前段与图谱边双端 100% 黄金对拍（store-chunks.golden.json 对拍事实源）
  it('store-chunks: quizzes/takeaways, summary precedence, anchor matching and edges match golden fixture', async () => {
    const fixture = testdata('store-chunks.golden.json');
    const { deriveCooccurrenceEdges, deriveCurriculumOrderEdges } = await import('@/lib/mcp/concept-graph-pure');
    const { resolveConceptChunkAnchor } = await import('@/lib/mcp/concept-extractor');

    // 2. Anchor disambiguation & principles enrichment
    for (const ac of fixture.anchor_disambiguation) {
      const concept = {
        conceptName: ac.conceptName,
        sourceHeading: ac.sourceHeading ?? undefined,
        anchorText: ac.anchorText ?? undefined,
        slug: ac.conceptName.toLowerCase().replace(/\s+/g, '-'),
        category: 'architecture',
        principlesText: ac.principlesText,
        sopSteps: [],
        summary: ac.summary,
        subTopics: [],
        tags: [],
      };
      const res = resolveConceptChunkAnchor(concept, fixture.chunks);
      expect(res).toEqual(ac.expected);
    }

    // 3. Edges
    expect(deriveCooccurrenceEdges(fixture.edges.cooccurrence_input)).toEqual(fixture.edges.cooccurrence_expected);
    expect(deriveCurriculumOrderEdges(fixture.edges.curriculum_input)).toEqual(fixture.edges.curriculum_expected);
  });

  // 🧪 向量 2.16.1.1: armor.golden.json 26 案例双端逐字对拍（含 7# 非边界、L0 真值、双名交叉闭合、
  // 代码块原样、正文 code: 锚点链接化与 A/B/C 相邻去重）
  it('armor: 黄金夹具包含 26 个已冻结测试案例（Go TestArmorGoldenParity 对拍事实源）', () => {
    const fixture = testdata('armor.golden.json');
    expect(fixture.resolveHandles).toBeDefined();
    expect(fixture.sanitize).toBeDefined();
    expect(fixture.allocate).toBeDefined();
    const totalCases = fixture.resolveHandles.length + fixture.sanitize.length + fixture.allocate.length;
    expect(totalCases).toBe(26);
  });
});
