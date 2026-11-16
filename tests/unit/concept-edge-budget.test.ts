import { test, expect, describe } from 'vitest';
import { prioritizeEdgesForBudget, computeRepoEdgeCap } from '@/lib/mcp/concept-graph';
import type { DerivedEdge } from '@/lib/mcp/concept-graph';

/** 造一条 related 共现边（方向按 id 字典序，与 deriveCooccurrenceEdges 一致） */
function edge(sourceId: string, targetId: string, weight = 0.5): DerivedEdge {
  const [s, t] = [sourceId, targetId].sort();
  return { sourceId: s, targetId: t, type: 'related', weight, source: 'cooccurrence' };
}

function curriculum(sourceId: string, targetId: string): DerivedEdge {
  return { sourceId, targetId, type: 'successor', weight: 0.3, source: 'curriculum_order' };
}

describe('prioritizeEdgesForBudget 边预算截断', () => {
  test('curriculum 边无条件全保：预算不足时也不被共现边挤掉', () => {
    const curriculumEdges = [curriculum('a', 'b'), curriculum('b', 'c'), curriculum('c', 'd')];
    const cooccurrence = Array.from({ length: 20 }, (_, i) => edge(`n${i}`, `n${i + 1}`));
    const result = prioritizeEdgesForBudget(curriculumEdges, cooccurrence, 5);
    const keptCurriculum = result.filter((e) => e.source === 'curriculum_order');
    expect(keptCurriculum).toHaveLength(3);
    expect(result).toHaveLength(5);
  });

  test('稀缺优先：双长尾边先保留，枢纽-叶子边靠后舍弃', () => {
    // 枢纽 hub 与 8 个叶子各有一条边（和度数 8+1=9）
    const hubEdges = Array.from({ length: 8 }, (_, i) => edge('hub', `leaf${i}`));
    // 一条只连接两个长尾概念的低度数边（和度数 1+1=2）
    const tailEdge = edge('tail-a', 'tail-b');
    const cooccurrence = [...hubEdges, tailEdge];

    // 预算只够留 1 条共现边：应保留双长尾边，而不是任一枢纽边
    const result = prioritizeEdgesForBudget([], cooccurrence, 1);
    expect(result).toHaveLength(1);
    expect(result[0].sourceId).toBe('tail-a');
    expect(result[0].targetId).toBe('tail-b');
  });

  test('预算充足时不丢任何边，且顺序为 curriculum 在前', () => {
    const curriculumEdges = [curriculum('a', 'b')];
    const cooccurrence = [edge('x', 'y'), edge('y', 'z')];
    const result = prioritizeEdgesForBudget(curriculumEdges, cooccurrence, 100);
    expect(result).toHaveLength(3);
    expect(result[0].source).toBe('curriculum_order');
  });

  test('cap ≤ 0 返回空数组（防御）', () => {
    expect(prioritizeEdgesForBudget([curriculum('a', 'b')], [], 0)).toEqual([]);
  });

  test('确定性：同输入重跑输出一致（排序 tie-break 稳定）', () => {
    const cooccurrence = Array.from({ length: 30 }, (_, i) => edge(`n${i % 7}`, `n${(i + 3) % 7}`));
    const run1 = prioritizeEdgesForBudget([], cooccurrence, 6);
    const run2 = prioritizeEdgesForBudget([], cooccurrence, 6);
    expect(run1).toEqual(run2);
  });
});

describe('computeRepoEdgeCap 归并组数换基', () => {
  test('夹在 [500, 4000] 区间', () => {
    expect(computeRepoEdgeCap(10, 5)).toBe(500);       // 小仓保底
    expect(computeRepoEdgeCap(100000, 5000)).toBe(4000); // 巨仓封顶
  });

  test('预算随归并组数（而非碎片变体数）线性增长', () => {
    // 未触及封顶区间内对比：同文档数下，归并组数越少预算越低（碎片变体不再虚增预算）
    const merged = computeRepoEdgeCap(100, 30);
    const fragmented = computeRepoEdgeCap(200, 30);
    expect(merged).toBe(100 * 12 + 30 * 8); // 1440
    expect(fragmented).toBe(200 * 12 + 30 * 8); // 2640
    expect(merged).toBeLessThan(fragmented);
  });
});
