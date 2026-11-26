import { describe, it, expect, test, vi } from 'vitest';
import { coercePlanDraft, validatePlan, UpdatePlanValidationError, decideExecutionStrategy, MAX_PLAN_ITEMS } from '@/engine/update-applier';
import { type UpdatePlan } from '@/engine/update-planner';
import { type UpdateCandidateSet, codeChapterPath, clusterChapterNo, isCodeChapterPath, buildUpdateCandidateSet } from '@/engine/update-candidate-set';

describe('update-planner-and-routing', () => {
  const candidateSet: UpdateCandidateSet = {
    chapters: [
      { path: 'doc1.md', title: null, oldSummary: null, change: 'structural', affectedFiles: [{ path: 'doc1.md', change: 'removed' }] },
      { path: 'doc2.md', title: null, oldSummary: null, change: 'structural', affectedFiles: [{ path: 'doc2.md', change: 'removed' }] },
      { path: 'doc3.md', title: null, oldSummary: null, change: 'content', affectedFiles: [{ path: 'doc3.md', change: 'modified' }] },
      { path: 'doc4.md', title: null, oldSummary: null, change: 'content', affectedFiles: [{ path: 'doc4.md', change: 'modified' }] },
    ],
    unmatchedFiles: [],
    structuralAdds: [],
    structuralRemoves: [],
    diffStats: { added: 0, modified: 2, removed: 2, renamed: 0 },
    hasOldArchive: false,
  };

  it('coercePlanDraft: Git 事实核验放行真删除、矫正幻觉 remove 与混合删除、剔除 rename', () => {
    const validPlan: UpdatePlan = {
      chapters: [
        { path: 'doc1.md', action: 'remove', reason: 'deleted', evidence: 'doc1.md' },
        { path: 'doc2.md', action: 'remove', reason: 'deleted', evidence: 'doc2.md' },
        { path: 'doc3.md', action: 'keep', reason: 'unchanged', evidence: '' },
        { path: 'doc4.md', action: 'update', reason: 'modified', evidence: '' },
      ],
      summary: 'mixed',
    };
    expect(coercePlanDraft(validPlan, candidateSet).coerced).toHaveLength(0);

    const hallucinated = coercePlanDraft(
      {
        chapters: [
          { path: 'doc1.md', action: 'remove', reason: '', evidence: '' },
          { path: 'doc2.md', action: 'remove', reason: '', evidence: '' },
          { path: 'doc3.md', action: 'remove', reason: '幻觉', evidence: '' },
          { path: 'doc4.md', action: 'remove', reason: '幻觉', evidence: '' },
        ],
        summary: '75%',
      },
      candidateSet
    );
    expect(hallucinated.coerced.map((a) => a.path).sort()).toEqual(['doc3.md', 'doc4.md']);
    expect(hallucinated.plan.chapters.find((c) => c.path === 'doc3.md')?.action).toBe('update');

    const hybrid = coercePlanDraft(
      { chapters: [{ path: 'chapters/01.mdx', action: 'remove', reason: '', evidence: '' }], summary: '' },
      {
        ...candidateSet,
        chapters: [
          {
            path: 'chapters/01.mdx',
            title: null,
            oldSummary: null,
            change: 'structural',
            affectedFiles: [{ path: 'src/old.ts', change: 'removed' }, { path: 'src/kept.ts', change: 'modified' }],
          },
        ],
      }
    );
    expect(hybrid.plan.chapters[0].action).toBe('update');

    const renamed = coercePlanDraft(
      { chapters: [{ path: 'docs/old.md', action: 'remove', reason: '', evidence: '' }], summary: '' },
      {
        ...candidateSet,
        chapters: [
          { path: 'docs/old.md', title: null, oldSummary: null, change: 'content', affectedFiles: [{ path: 'docs/old.md', change: 'renamed' }], rename: { from: 'docs/old.md', to: 'docs/new.md' } },
        ],
      }
    );
    expect(renamed.plan.chapters).toHaveLength(0);
    expect(renamed.coerced[0]).toMatchObject({ path: 'docs/old.md', toAction: 'DROP' });
  });

  it('validatePlan: 越权目标与超上限拦截', () => {
    expect(() => validatePlan({ chapters: [{ path: 'not-in-candidate.md', action: 'update', reason: '', evidence: '' }], summary: '' }, candidateSet)).toThrowError(
      UpdatePlanValidationError
    );
    expect(() =>
      validatePlan({ chapters: Array.from({ length: 51 }, (_, i) => ({ path: `doc${i}.md`, action: 'keep', reason: '', evidence: '' })), summary: '' }, candidateSet)
    ).toThrowError('超过上限');
  });

  it('decideExecutionStrategy: 真实删除率路由（全量分母 / 60% 重建 / 超限重建 / 幻觉不计入）', () => {
    const mkSet = (n: number, removed: number): UpdateCandidateSet => ({
      chapters: Array.from({ length: n }, (_, i) => ({
        path: `doc${i + 1}.md`,
        title: null,
        oldSummary: null,
        change: i < removed ? 'structural' : 'content',
        affectedFiles: [{ path: `doc${i + 1}.md`, change: i < removed ? 'removed' : 'modified' }],
      })),
      unmatchedFiles: [],
      structuralAdds: [],
      structuralRemoves: [],
      diffStats: { added: 0, modified: n - removed, removed, renamed: 0 },
      hasOldArchive: false,
    });
    const mkPlan = (paths: string[]): UpdatePlan => ({ chapters: paths.map((p) => ({ path: p, action: 'remove', reason: '', evidence: '' })), summary: '' });

    expect(decideExecutionStrategy(mkPlan(['doc1.md', 'doc2.md']), mkSet(100, 2), 100)).toMatchObject({ strategy: 'INCREMENTAL_PATCH', trueRemoves: 2 });
    const cs60 = mkSet(100, 60);
    expect(decideExecutionStrategy(mkPlan(cs60.chapters.slice(0, 60).map((c) => c.path)), cs60, 100)).toMatchObject({
      strategy: 'MAJOR_VERSION_REBUILD',
      trueRemoves: 60,
    });
    const csMax = mkSet(MAX_PLAN_ITEMS + 10, MAX_PLAN_ITEMS);
    expect(decideExecutionStrategy(mkPlan(csMax.chapters.slice(0, MAX_PLAN_ITEMS).map((c) => c.path)), csMax, MAX_PLAN_ITEMS + 10)).toMatchObject({
      strategy: 'MAJOR_VERSION_REBUILD',
      trueRemoves: MAX_PLAN_ITEMS,
    });
    expect(decideExecutionStrategy(mkPlan(['doc1.md', 'doc2.md', 'doc3.md', 'doc4.md']), mkSet(4, 1), 4)).toMatchObject({
      strategy: 'INCREMENTAL_PATCH',
      trueRemoves: 1,
    });
  });

  test('update-candidate-set 命名规约与 sidecar Fail-Closed 透传', async () => {
    expect(codeChapterPath(3)).toBe('chapters/03.mdx');
    expect(isCodeChapterPath('chapters/03.mdx')).toBe(true);
    expect(isCodeChapterPath('docs/intro.md')).toBe(false);
    expect(clusterChapterNo({ teachingOrder: 5 })).toBe(5);
    expect(clusterChapterNo({ chapterNo: 7, teachingOrder: 1 })).toBe(7);

    const canned = { chapters: [{ path: 'chapters/01.mdx', action: 'update' as const, affectedFiles: [] }], unmatchedFiles: [], structuralAdds: [], structuralRemoves: [], diffStats: { added: 0, modified: 1, removed: 0 } };
    const spy = vi.spyOn(await import('@/engine/update-candidate-driver'), 'executeSidecarCandidateSet').mockResolvedValueOnce(canned as never);
    expect(await buildUpdateCandidateSet({ owner: 'o', repo: 'r', branch: 'main', fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40), repositoryId: 'rid' })).toEqual(canned);
    spy.mockRestore();

    delete process.env.INTERNAL_API_TOKEN;
    delete process.env.WORKER_SIDECAR_URL;
    await expect(
      buildUpdateCandidateSet({ owner: 'o', repo: 'r', branch: 'main', fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40), repositoryId: 'rid' })
    ).rejects.toThrow(/sidecar unreachable|not configured/);
  });
});
