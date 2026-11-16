import { test, expect, describe, vi, beforeEach } from 'vitest';
import {
  validatePlan,
  applyUpdatePlan,
  MAX_PLAN_ITEMS,
  UpdatePlanValidationError,
} from '@/engine/update-applier';
import type { UpdatePlan } from '@/engine/update-planner';
import type { UpdateCandidateSet } from '@/engine/update-candidate-set';
import { prisma } from '@/lib/db';
import { registerImportSnapshot } from '@/engine/import-snapshot';
import { callSidecar } from '@/lib/sidecar-client';

// 事务内 mock 提升为具名引用：跨用例断言"结构副作用是否被触发"（repository.update 等）
const txMocks = vi.hoisted(() => ({
  document: {
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    create: vi.fn().mockResolvedValue({ id: 'doc-new' }),
  },
  repository: {
    findUnique: vi.fn().mockResolvedValue({ owner: 'test-owner', repo: 'test-repo' }),
    update: vi.fn().mockResolvedValue({}),
  },
  tutorialOutline: {
    aggregate: vi.fn().mockResolvedValue({ _max: { version: 1 } }),
    create: vi.fn().mockResolvedValue({ id: 'outline-new', parts: [] }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    update: vi.fn().mockResolvedValue({ id: 'outline-new', isActive: true }),
    findFirst: vi.fn().mockResolvedValue(null),
  },
  outlineChapter: {
    create: vi.fn().mockResolvedValue({ id: 'ch-new' }),
  },
  importUpdateRun: {
    update: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn((cb: (tx: typeof txMocks) => unknown) => cb(txMocks)),
  },
}));

vi.mock('@/engine/import-snapshot', () => ({
  registerImportSnapshot: vi.fn().mockResolvedValue({ id: 'snapshot-1' }),
}));

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: vi.fn().mockImplementation(async (path: string, body: any) => {
    if (path === '/v1/documents/mutation') {
      return {
        ok: true,
        renamed: body?.renames?.length ?? 0,
        updated: body?.updates?.length ?? 0,
        removed: body?.removes?.length ?? 0,
        created: body?.creates?.length ?? 0,
        appliedRenames: body?.renames ?? [],
      };
    }
    return { ok: true, outlineId: 'outline-new' };
  }),
}));

describe('update-applier 计划校验与执行器（Stage 2 确定性执行）', () => {
  const baseCandidateSet: UpdateCandidateSet = {
    chapters: [
      {
        path: 'docs/01-intro.md',
        title: '起步',
        oldSummary: null,
        change: 'content',
        affectedFiles: [{ path: 'docs/01-intro.md', change: 'modified' }],
      },
      {
        path: 'docs/02-deprecated.md',
        title: '废弃',
        oldSummary: null,
        change: 'structural',
        affectedFiles: [{ path: 'docs/02-deprecated.md', change: 'removed' }],
      },
    ],
    unmatchedFiles: [
      { path: 'docs/new-chapter.md', change: 'added' },
      { path: 'docs/modified-orphan.md', change: 'modified' },
    ],
    structuralAdds: [
      {
        path: 'chapters/03.mdx',
        title: '新增子模块',
        oldSummary: null,
        change: 'structural',
        affectedFiles: [{ path: 'src/sub/index.ts', change: 'added' }],
      },
    ],
    structuralRemoves: [],
    diffStats: { added: 1, modified: 1, removed: 1, renamed: 0 },
    hasOldArchive: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validatePlan 守卫校验', () => {
    test('超过 MAX_PLAN_ITEMS 上限抛出 UpdatePlanValidationError', () => {
      const oversizedPlan: UpdatePlan = {
        chapters: Array.from({ length: MAX_PLAN_ITEMS + 1 }, (_, i) => ({
          path: `docs/doc-${i}.md`,
          action: 'update',
          reason: '超限测试',
          evidence: '',
        })),
        summary: '超限计划',
      };

      expect(() => validatePlan(oversizedPlan, baseCandidateSet)).toThrow(
        UpdatePlanValidationError
      );
      expect(() => validatePlan(oversizedPlan, baseCandidateSet)).toThrow(/超过上限 50/);
    });

    test('update / keep / remove 目标不在候选集时拦截（越权）', () => {
      const illegalPlan: UpdatePlan = {
        chapters: [
          {
            path: 'docs/unauthorized-file.md', // 不在候选集中
            action: 'update',
            reason: '越权修改',
            evidence: '',
          },
        ],
        summary: '非法计划',
      };

      expect(() => validatePlan(illegalPlan, baseCandidateSet)).toThrow(
        UpdatePlanValidationError
      );
      expect(() => validatePlan(illegalPlan, baseCandidateSet)).toThrow(/越权/);
    });

    test('add 目标不在 added 文件或 structuralAdds 时拦截（越权）', () => {
      const illegalAddPlan: UpdatePlan = {
        chapters: [
          {
            path: 'docs/modified-orphan.md', // 这是 modified 文件，不是 added
            action: 'add',
            reason: '非法 add',
            evidence: '',
          },
        ],
        summary: '非法 add 计划',
      };

      expect(() => validatePlan(illegalAddPlan, baseCandidateSet)).toThrow(
        UpdatePlanValidationError
      );
      expect(() => validatePlan(illegalAddPlan, baseCandidateSet)).toThrow(/add 目标.*不在候选集内/);
    });

    test('合法计划放行（候选集内 update/keep/remove + 合法 add）', () => {
      const validPlan: UpdatePlan = {
        chapters: [
          { path: 'docs/01-intro.md', action: 'update', reason: '更新内容', evidence: 'docs/01-intro.md' },
          { path: 'docs/02-deprecated.md', action: 'remove', reason: '文件已删除', evidence: 'docs/02-deprecated.md' },
          { path: 'docs/new-chapter.md', action: 'add', reason: '新增文件独立成章', evidence: 'docs/new-chapter.md' },
          { path: 'chapters/03.mdx', action: 'add', reason: '新模块成章', evidence: 'src/sub/index.ts' },
        ],
        summary: '合法更新计划',
      };

      expect(() => validatePlan(validPlan, baseCandidateSet)).not.toThrow();
    });
  });

  describe('applyUpdatePlan 事务与分支流转', () => {
    const validPlan: UpdatePlan = {
      chapters: [
        { path: 'docs/01-intro.md', action: 'update', reason: '更新内容', evidence: '' },
        { path: 'docs/02-deprecated.md', action: 'remove', reason: '文件删除', evidence: '' },
        { path: 'docs/new-chapter.md', action: 'add', reason: '新增章节', evidence: '' },
      ],
      summary: '应用测试计划',
    };

    // 🧪 [5.2.3.1 · CRITICAL] 应用更新时遭遇数据库局部断网产生半更新状态
    // AntiPattern: 多条独立 await prisma.document.update() 无事务保护
    // DefenseAssertion: 全量更新包裹在单个 prisma.$transaction 中，失败全量回滚
    test('5.2.3.1 首个更新者（repo.gitSha !== toSha）：单事务原子执行更新文档 + patch navTree + 推进 gitSha', async () => {
      (prisma.repository.findUnique as any).mockResolvedValue({
        id: 'repo-1',
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main',
        gitSha: '1111111111111111111111111111111111111111', // 旧 sha，与 toSha 不同
        navTree: [
          { name: '01-intro', title: '起步', type: 'file', path: 'docs/01-intro.md', url: '/docs/o/r/01-intro' },
          { name: '02-deprecated', title: '废弃', type: 'file', path: 'docs/02-deprecated.md', url: '/docs/o/r/02-deprecated' },
        ],
        repoProfile: {},
      });

      const result = await applyUpdatePlan({
        repositoryId: 'repo-1',
        userId: 'user-1',
        docOwnerId: null,
        fromSha: '1111111111111111111111111111111111111111',
        toSha: '2222222222222222222222222222222222222222',
        plan: validPlan,
        candidateSet: baseCandidateSet,
        runId: 'run-1',
      });

      expect(result.navTreePatched).toBe(true);
      expect(result.gitShaAdvanced).toBe(true);
      expect(result.updatedDocs).toBe(1);
      expect(result.removedDocs).toBe(1);
      expect(result.addedDocs).toBe(1);

      // 结构副作用绑定归属：共享正典更新者推进公共基线并清红点
      expect(callSidecar).toHaveBeenCalledWith(
        '/v1/repos/patch',
        expect.objectContaining({
          id: 'repo-1',
          gitSha: '2222222222222222222222222222222222222222',
          hasUpstreamUpdate: false,
        }),
        expect.anything()
      );

      // 大纲二阶段写侧单源化：验证新版本 TutorialOutline 已通过 sidecar 落库激活
      expect(callSidecar).toHaveBeenCalledWith(
        '/v1/outlines/draft/store',
        expect.objectContaining({
          repositoryId: 'repo-1',
          isActive: true,
        }),
        expect.objectContaining({ label: 'store outline draft' })
      );

      expect(registerImportSnapshot).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: 'user-1',
          repositoryId: 'repo-1',
          sha: '2222222222222222222222222222222222222222',
          skipDocumentReset: true,
        })
      );
    });

    test('下游用户同步（repo.gitSha === toSha）：只同步个人文档副本，不重复 patch navTree', async () => {
      (prisma.repository.findUnique as any).mockResolvedValue({
        id: 'repo-1',
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main',
        gitSha: '2222222222222222222222222222222222222222', // 已被首个更新者推进到 toSha
        navTree: [],
        repoProfile: {},
      });

      const result = await applyUpdatePlan({
        repositoryId: 'repo-1',
        userId: 'user-2',
        docOwnerId: 'user-2',
        fromSha: '1111111111111111111111111111111111111111',
        toSha: '2222222222222222222222222222222222222222',
        plan: validPlan,
        candidateSet: baseCandidateSet,
      });

      // 结构副作用绑定归属：绝不冒充公共同步（否则共享行停留旧版时红点已消、树已换新）
      expect(txMocks.repository.update).not.toHaveBeenCalled();
      expect(result.navTreePatched).toBe(false);
      expect(result.gitShaAdvanced).toBe(false);
      // 归属者自己的文档照常处理
      expect(result.updatedDocs).toBe(1);
      expect(result.removedDocs).toBe(1);
      expect(result.addedDocs).toBe(1);
      expect(callSidecar).toHaveBeenCalledWith(
        '/v1/documents/mutation',
        expect.objectContaining({
          repositoryId: 'repo-1',
          ownerUserId: 'user-2',
        }),
        expect.any(Object)
      );
    });

    test('私有副本更新者（docOwnerId 非空 + gitSha 落后）：不推进公共基线/navTree/红点，只动自己的行', async () => {
      (prisma.repository.findUnique as any).mockResolvedValue({
        id: 'repo-1',
        owner: 'test-owner',
        repo: 'test-repo',
        branch: 'main',
        gitSha: '1111111111111111111111111111111111111111', // 公共基线落后于 toSha
        navTree: [],
        repoProfile: {},
      });

      const result = await applyUpdatePlan({
        repositoryId: 'repo-1',
        userId: 'user-3',
        docOwnerId: 'user-3',
        fromSha: '1111111111111111111111111111111111111111',
        toSha: '2222222222222222222222222222222222222222',
        plan: validPlan,
        candidateSet: baseCandidateSet,
      });

      // 结构副作用绑定归属：绝不冒充公共同步（否则共享行停留旧版时红点已消、树已换新）
      expect(txMocks.repository.update).not.toHaveBeenCalled();
      expect(result.navTreePatched).toBe(false);
      expect(result.gitShaAdvanced).toBe(false);
      // 归属者自己的文档照常处理
      expect(result.updatedDocs).toBe(1);
      expect(result.removedDocs).toBe(1);
      expect(result.addedDocs).toBe(1);
      expect(callSidecar).toHaveBeenCalledWith(
        '/v1/documents/mutation',
        expect.objectContaining({
          repositoryId: 'repo-1',
          ownerUserId: 'user-3',
        }),
        expect.any(Object)
      );
    });

    test('Sidecar 在线时优先返回 Sidecar 直写结果，不触碰本地 Prisma 长事务', async () => {
      const driver = await import('@/engine/update-candidate-driver');
      const sidecarSpy = vi.spyOn(driver, 'executeSidecarUpdateApply').mockResolvedValueOnce({
        updatedDocs: 3,
        removedDocs: 0,
        addedDocs: 1,
        renamedDocs: 0,
        coercedActions: 0,
        navTreePatched: true,
        gitShaAdvanced: true,
      });

      const result = await applyUpdatePlan({
        repositoryId: 'repo-1',
        userId: 'user-1',
        docOwnerId: null,
        fromSha: '1111111111111111111111111111111111111111',
        toSha: '2222222222222222222222222222222222222222',
        plan: validPlan,
        candidateSet: baseCandidateSet,
      });

      expect(sidecarSpy).toHaveBeenCalled();
      expect(result.updatedDocs).toBe(3);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      sidecarSpy.mockRestore();
    });
  });
});
