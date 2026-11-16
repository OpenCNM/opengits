import { describe, it, expect } from 'vitest';
import { decideExecutionStrategy, MAX_PLAN_ITEMS } from '@/engine/update-applier';
import type { UpdatePlan } from '@/engine/update-planner';
import type { UpdateCandidateSet } from '@/engine/update-candidate-set';

/**
 * 大版本智能路由（decideExecutionStrategy 纯函数）：
 * - 分母 = 归属全部现存章节数（非候选集大小）——小 diff 高占比不误判大版本
 * - 真实删除率 = Git 事实核验后的合法 remove ÷ 全量章节
 * - 超阈值或合法删除规模爆表 → MAJOR_VERSION_REBUILD（快照归档 + 全量冷重建），
 *   不再抛 REMOVE_RATIO_EXCEEDED 中断
 */

function candidateSetWith(nChapters: number, removedCount: number): UpdateCandidateSet {
  const chapters = Array.from({ length: nChapters }, (_, i) => ({
    path: `doc${i + 1}.md`,
    title: null,
    oldSummary: null,
    change: i < removedCount ? ('structural' as const) : ('content' as const),
    affectedFiles: [
      {
        path: `doc${i + 1}.md`,
        change: i < removedCount ? ('removed' as const) : ('modified' as const),
      },
    ],
  }));
  return {
    chapters,
    unmatchedFiles: [],
    structuralAdds: [],
    structuralRemoves: [],
    diffStats: { added: 0, modified: nChapters - removedCount, removed: removedCount, renamed: 0 },
    hasOldArchive: false,
  };
}

function planWithRemoves(paths: string[]): UpdatePlan {
  return {
    chapters: paths.map((path) => ({ path, action: 'remove' as const, reason: '', evidence: '' })),
    summary: '',
  };
}

describe('decideExecutionStrategy：真实删除率路由', () => {
  it('场景 A：常规增量（100 章删 2 章 = 2%）→ INCREMENTAL_PATCH', () => {
    const cs = candidateSetWith(100, 2);
    const decision = decideExecutionStrategy(planWithRemoves(['doc1.md', 'doc2.md']), cs, 100);
    expect(decision.strategy).toBe('INCREMENTAL_PATCH');
    expect(decision.trueRemoves).toBe(2);
    expect(decision.realRemoveRatio).toBeCloseTo(0.02);
  });

  // 🧪 [5.5.1.1 · HIGH] 破坏性大版本更新被当成普通增量补丁应用导致大部分章节被误删
  it('5.5.1.1 场景 B：大版本破坏性重写（100 章删 60 章 = 60%）→ MAJOR_VERSION_REBUILD', () => {
    const cs = candidateSetWith(100, 60);
    const decision = decideExecutionStrategy(
      planWithRemoves(cs.chapters.slice(0, 60).map((c) => c.path)),
      cs,
      100
    );
    expect(decision.strategy).toBe('MAJOR_VERSION_REBUILD');
    expect(decision.trueRemoves).toBe(60);
  });

  it('小 diff 高占比不失真：全仓 100 章，候选 2 章全删 → 增量（v1 的 2/2=100% 缺陷回归）', () => {
    const cs = candidateSetWith(100, 2);
    // 候选集只含 2 章且全部真删除；分母取全量章节 100 → 2%
    const decision = decideExecutionStrategy(planWithRemoves(['doc1.md', 'doc2.md']), cs, 100);
    expect(decision.strategy).toBe('INCREMENTAL_PATCH');
    expect(decision.totalChapters).toBe(100);
  });

  it('合法删除规模爆表（≥ MAX_PLAN_ITEMS）→ MAJOR_VERSION_REBUILD（LLM 失控等价于剧变）', () => {
    const cs = candidateSetWith(MAX_PLAN_ITEMS + 10, MAX_PLAN_ITEMS);
    const decision = decideExecutionStrategy(
      planWithRemoves(cs.chapters.slice(0, MAX_PLAN_ITEMS).map((c) => c.path)),
      cs,
      MAX_PLAN_ITEMS + 10
    );
    expect(decision.strategy).toBe('MAJOR_VERSION_REBUILD');
    expect(decision.trueRemoves).toBe(MAX_PLAN_ITEMS);
  });

  it('幻觉 remove 不计入真实删除率（矫正后路由，而非草案路由）', () => {
    const cs = candidateSetWith(4, 1); // 只有 doc1.md 是 Git 真删除
    // LLM 草案把 4 章全标 remove（75%）——但只有 1 章有 Git 事实支撑
    const decision = decideExecutionStrategy(
      planWithRemoves(['doc1.md', 'doc2.md', 'doc3.md', 'doc4.md']),
      cs,
      4
    );
    expect(decision.trueRemoves).toBe(1);
    expect(decision.strategy).toBe('INCREMENTAL_PATCH');
  });
});
