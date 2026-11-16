import { describe, it, expect } from 'vitest';
import { coercePlanDraft, validatePlan, UpdatePlanValidationError } from '@/engine/update-applier';
import type { UpdatePlan } from '@/engine/update-planner';
import type { UpdateCandidateSet } from '@/engine/update-candidate-set';

/**
 * remove 草案护栏（A2 语义演化为 v2 路由）：
 * - LLM 的 remove 是"不可信草案"——coercePlanDraft 逐条用 Git 事实核验，
 *   源文件未全部消失的幻觉删除矫正为 update，不再抛 REMOVE_RATIO_EXCEEDED 中断；
 * - 真实删除率超阈值的路由职责移交 decideExecutionStrategy（见 update-strategy-routing.test.ts）。
 */

/** Git 事实：4 章 diff，其中 2 章源文件真删除 */
const candidateSet: UpdateCandidateSet = {
  chapters: [
    {
      path: 'doc1.md',
      title: null,
      oldSummary: null,
      change: 'structural',
      affectedFiles: [{ path: 'doc1.md', change: 'removed' }],
    },
    {
      path: 'doc2.md',
      title: null,
      oldSummary: null,
      change: 'structural',
      affectedFiles: [{ path: 'doc2.md', change: 'removed' }],
    },
    {
      path: 'doc3.md',
      title: null,
      oldSummary: null,
      change: 'content',
      affectedFiles: [{ path: 'doc3.md', change: 'modified' }],
    },
    {
      path: 'doc4.md',
      title: null,
      oldSummary: null,
      change: 'content',
      affectedFiles: [{ path: 'doc4.md', change: 'modified' }],
    },
  ],
  unmatchedFiles: [],
  structuralAdds: [],
  structuralRemoves: [],
  diffStats: { added: 0, modified: 2, removed: 2, renamed: 0 },
  hasOldArchive: false,
};

describe('coercePlanDraft：remove 草案的 Git 事实核验', () => {
  it('合法 remove（源文件真删除）原样通过', () => {
    const plan: UpdatePlan = {
      chapters: [
        { path: 'doc1.md', action: 'remove', reason: 'deleted', evidence: 'doc1.md' },
        { path: 'doc2.md', action: 'remove', reason: 'deleted', evidence: 'doc2.md' },
        { path: 'doc3.md', action: 'keep', reason: 'unchanged', evidence: '' },
        { path: 'doc4.md', action: 'update', reason: 'modified', evidence: '' },
      ],
      summary: 'mixed plan',
    };

    const { plan: coerced, coerced: audit } = coercePlanDraft(plan, candidateSet);
    expect(audit).toHaveLength(0);
    expect(coerced.chapters.find((c) => c.path === 'doc1.md')?.action).toBe('remove');
    expect(coerced.chapters.find((c) => c.path === 'doc2.md')?.action).toBe('remove');
  });

  // 🧪 [5.2.2.1 · CRITICAL] LLM 计划将核心基础章节误判为 Remove 导致教程内容被清空
  // AntiPattern: 未经安全护栏直接应用 LLM 删除计划
  // DefenseAssertion: 若 Remove 章节数 > 50% 强制阻断或经 Git 事实核验将幻觉删除强制矫正为 update
  it('5.2.2.1 幻觉 remove（源文件仍存在）矫正为 update，不中断整个计划', () => {
    const plan: UpdatePlan = {
      chapters: [
        { path: 'doc1.md', action: 'remove', reason: 'deleted', evidence: '' },
        { path: 'doc2.md', action: 'remove', reason: 'deleted', evidence: '' },
        { path: 'doc3.md', action: 'remove', reason: 'LLM 幻觉：文件并未删除', evidence: '' },
        { path: 'doc4.md', action: 'remove', reason: 'LLM 幻觉：文件并未删除', evidence: '' },
      ],
      summary: '75% remove draft',
    };

    const { plan: coerced, coerced: audit } = coercePlanDraft(plan, candidateSet);
    // doc1/doc2 是 Git 真删除，保留；doc3/doc4 幻觉删除矫正为 update
    expect(audit).toHaveLength(2);
    expect(audit.map((a) => a.path).sort()).toEqual(['doc3.md', 'doc4.md']);
    expect(audit.every((a) => a.fromAction === 'remove' && a.toAction === 'update')).toBe(true);
    expect(coerced.chapters.find((c) => c.path === 'doc3.md')?.action).toBe('update');
    expect(coerced.chapters.find((c) => c.path === 'doc4.md')?.action).toBe('update');
  });

  it('混合删除（部分文件 removed 部分仅 modified）的章节不算真删除', () => {
    const hybridSet: UpdateCandidateSet = {
      ...candidateSet,
      chapters: [
        {
          path: 'chapters/01.mdx',
          title: null,
          oldSummary: null,
          change: 'structural',
          affectedFiles: [
            { path: 'src/old.ts', change: 'removed' },
            { path: 'src/kept.ts', change: 'modified' },
          ],
        },
      ],
    };
    const plan: UpdatePlan = {
      chapters: [{ path: 'chapters/01.mdx', action: 'remove', reason: '部分文件被删', evidence: '' }],
      summary: '',
    };

    const { plan: coerced, coerced: audit } = coercePlanDraft(plan, hybridSet);
    expect(audit).toHaveLength(1);
    expect(coerced.chapters[0].action).toBe('update');
  });

  it('rename 章节的任何裁决整条剔除（代码迁移路径，LLM 不参与）', () => {
    const renameSet: UpdateCandidateSet = {
      ...candidateSet,
      chapters: [
        {
          path: 'docs/old-name.md',
          title: null,
          oldSummary: null,
          change: 'content',
          affectedFiles: [{ path: 'docs/old-name.md', change: 'renamed' }],
          rename: { from: 'docs/old-name.md', to: 'docs/new-name.md' },
        },
      ],
    };
    const plan: UpdatePlan = {
      chapters: [
        { path: 'docs/old-name.md', action: 'remove', reason: 'LLM 想删除被改名的章节', evidence: '' },
      ],
      summary: '',
    };

    const { plan: coerced, coerced: audit } = coercePlanDraft(plan, renameSet);
    expect(coerced.chapters).toHaveLength(0);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ path: 'docs/old-name.md', fromAction: 'remove', toAction: 'DROP' });
  });
});

describe('validatePlan：越权与上限守卫保留', () => {
  it('越权目标仍然抛错（矫正不豁免越权）', () => {
    const plan: UpdatePlan = {
      chapters: [{ path: 'not-in-candidate.md', action: 'update', reason: '', evidence: '' }],
      summary: '',
    };
    expect(() => validatePlan(plan, candidateSet)).toThrowError(UpdatePlanValidationError);
  });

  it('章节数超上限仍然抛错', () => {
    const plan: UpdatePlan = {
      chapters: Array.from({ length: 51 }, (_, i) => ({
        path: `doc${i}.md`,
        action: 'keep' as const,
        reason: '',
        evidence: '',
      })),
      summary: '',
    };
    expect(() => validatePlan(plan, candidateSet)).toThrowError('超过上限');
  });
});
