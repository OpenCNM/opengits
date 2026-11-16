import { test, it, expect, describe, vi, beforeEach } from 'vitest';
import { applyUpdatePlan } from '@/engine/update-applier';
import type { UpdatePlan } from '@/engine/update-planner';
import type { UpdateCandidateSet } from '@/engine/update-candidate-set';
import { patchNavTree, NavNode } from '@/engine/navtree-patch';
import { prisma } from '@/lib/db';
import { callSidecar } from '@/lib/sidecar-client';

/**
 * rename 确定性迁移（v2 核心语义）：
 * - rename = diffArchives 哈希配对（内容未变）→ 只迁移 Document.path + navTree 节点，
 *   绝不重转录（content 不置空）；
 * - LLM 对 rename 章节输出 remove 也无法误删（coercePlanDraft 剔除，代码接管）；
 * - 目标路径被同归属占用（唯一约束冲突）→ 该条降级跳过，不中断事务。
 */

const txMocks = vi.hoisted(() => ({
  document: {
    findFirst: vi.fn(),
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
      const isOccupied = body?.renames?.some((r: any) => r.to === 'docs/occupied.md');
      const renamed = isOccupied ? 0 : (body?.renames?.length ?? 0);
      return {
        ok: true,
        renamed,
        updated: body?.updates?.length ?? 0,
        removed: body?.removes?.length ?? 0,
        created: body?.creates?.length ?? 0,
        appliedRenames: isOccupied ? [] : (body?.renames ?? []),
      };
    }
    return { ok: true, outlineId: 'outline-new' };
  }),
}));

/** Git 事实：docs/old-guide.md 被整体改名为 docs/new-guide.md（内容未变） */
const renameCandidateSet: UpdateCandidateSet = {
  chapters: [
    {
      path: 'docs/old-guide.md',
      title: '指南',
      oldSummary: '旧摘要',
      change: 'content',
      affectedFiles: [{ path: 'docs/old-guide.md', change: 'renamed' }],
      rename: { from: 'docs/old-guide.md', to: 'docs/new-guide.md' },
    },
  ],
  unmatchedFiles: [],
  structuralAdds: [],
  structuralRemoves: [],
  diffStats: { added: 0, modified: 0, removed: 0, renamed: 1 },
  hasOldArchive: true,
};

const repoRow = {
  id: 'repo-1',
  owner: 'test-owner',
  repo: 'test-repo',
  branch: 'main',
  gitSha: '1111111111111111111111111111111111111111',
  navTree: [
    {
      name: 'old-guide',
      title: '指南',
      type: 'file',
      path: 'docs/old-guide.md',
      // URL 口径 = 去扩展名全路径（与 structurizer / docs-page-loader 的 slug 解析一致）
      url: '/docs/test-owner/test-repo/docs/old-guide',
    },
  ] as NavNode[],
  repoProfile: {},
};

describe('applyUpdatePlan：rename 路径迁移', () => {
  const setupDefaultSidecar = () => {
    vi.mocked(callSidecar).mockImplementation(async (path: string, body: any) => {
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
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultSidecar();
    // clearAllMocks 不清除 mockResolvedValue 实现：显式复位 findFirst 缺省（未命中），
    // 防止"目标路径被占用"用例的实现泄漏到后续用例
    txMocks.document.findFirst.mockResolvedValue(undefined);
    txMocks.document.updateMany.mockResolvedValue({ count: 1 });
    (prisma.repository.findUnique as any).mockResolvedValue(repoRow);
  });

  // 🧪 [5.5.3.1 · MEDIUM] 文件仅更名但被当成删除加新增浪费算力与丢失正典
  test('5.5.3.1 LLM 输出 remove 也无法误删：代码迁移路径且内容保留（不重转录）', async () => {
    // LLM 草案：对被改名的章节输出 remove（v1 场景会误删）
    const plan: UpdatePlan = {
      chapters: [
        { path: 'docs/old-guide.md', action: 'remove', reason: '误判为已删除', evidence: '' },
      ],
      summary: '',
    };

    const result = await applyUpdatePlan({
      repositoryId: 'repo-1',
      userId: 'user-1',
      docOwnerId: null,
      fromSha: '1111111111111111111111111111111111111111',
      toSha: '2222222222222222222222222222222222222222',
      plan,
      candidateSet: renameCandidateSet,
      runId: 'run-1',
    });

    // 路径迁移发生：旧 path → 新 path 通过 sidecar 原子 mutation 提交
    expect(callSidecar).toHaveBeenCalledWith(
      '/v1/documents/mutation',
      expect.objectContaining({
        repositoryId: 'repo-1',
        ownerUserId: null,
        renames: [{ from: 'docs/old-guide.md', to: 'docs/new-guide.md' }],
      }),
      expect.any(Object)
    );
    expect(result.renamedDocs).toBe(1);
    expect(result.coercedActions).toBe(1);

    // remove 未执行：草案条目已被剔除，绝不 deleteMany
    expect(txMocks.document.deleteMany).not.toHaveBeenCalled();

    // 零物化：callSidecar /v1/repos/patch 推进公共基线与红点，绝不再向 navTree 字段写入
    expect(callSidecar).toHaveBeenCalledWith(
      '/v1/repos/patch',
      expect.objectContaining({
        id: 'repo-1',
        gitSha: '2222222222222222222222222222222222222222',
        hasUpstreamUpdate: false,
      }),
      expect.anything()
    );

    // 零物化单一事实源：新版本 TutorialOutline 已通过 sidecar 落库激活
    expect(callSidecar).toHaveBeenCalledWith(
      '/v1/outlines/draft/store',
      expect.objectContaining({
        repositoryId: 'repo-1',
        isActive: true,
      }),
      expect.objectContaining({ label: 'store outline draft' })
    );
  });

  test('目标路径被占用（唯一约束冲突）：该条降级跳过，不中断事务', async () => {
    vi.mocked(callSidecar).mockImplementation(async (path: string) => {
      if (path === '/v1/documents/mutation') {
        return { ok: true, renamed: 0, updated: 0, removed: 0, created: 0, appliedRenames: [] };
      }
      return { ok: true, outlineId: 'outline-new' };
    });

    const result = await applyUpdatePlan({
      repositoryId: 'repo-1',
      userId: 'user-1',
      docOwnerId: null,
      fromSha: '1111111111111111111111111111111111111111',
      toSha: '2222222222222222222222222222222222222222',
      plan: { chapters: [], summary: '' },
      candidateSet: renameCandidateSet,
    });

    expect(result.renamedDocs).toBe(0);
    // 结构副作用照常（rename 跳过不影响其余流程）
    expect(result.gitShaAdvanced).toBe(true);
  });

  test('私有副本更新：迁移限定在该用户的行，不动公共基线', async () => {
    (prisma.repository.findUnique as any).mockResolvedValue({ ...repoRow, gitSha: '2222222222222222222222222222222222222222' });

    const result = await applyUpdatePlan({
      repositoryId: 'repo-1',
      userId: 'user-2',
      docOwnerId: 'user-2',
      fromSha: '1111111111111111111111111111111111111111',
      toSha: '2222222222222222222222222222222222222222',
      plan: { chapters: [], summary: '' },
      candidateSet: renameCandidateSet,
    });

    expect(callSidecar).toHaveBeenCalledWith(
      '/v1/documents/mutation',
      expect.objectContaining({
        repositoryId: 'repo-1',
        ownerUserId: 'user-2',
        renames: [{ from: 'docs/old-guide.md', to: 'docs/new-guide.md' }],
      }),
      expect.any(Object)
    );
    expect(result.renamedDocs).toBe(1);
    expect(result.navTreePatched).toBe(false);
    expect(result.gitShaAdvanced).toBe(false);
  });
});

describe('patchNavTree：rename 原地改写', () => {
  it('改写命中节点的 path/url/name，不动标题、不重排、不影响兄弟节点', () => {
    const tree: NavNode[] = [
      {
        name: 'a',
        title: 'A',
        type: 'file',
        path: 'docs/a.md',
        url: '/docs/o/r/a',
      },
      {
        name: 'dir',
        title: '目录',
        type: 'directory',
        path: 'docs/dir',
        url: '/docs/o/r/dir',
        children: [
          { name: 'old', title: '旧章', type: 'file', path: 'docs/dir/old.md', url: '/docs/o/r/dir/old' },
          { name: 'kept', title: '保留', type: 'file', path: 'docs/dir/kept.md', url: '/docs/o/r/dir/kept' },
        ],
      },
    ];

    const patched = patchNavTree(tree, {
      remove: [],
      add: [],
      rename: [{ from: 'docs/dir/old.md', to: 'docs/dir/new.md', toUrl: '/docs/o/r/dir/new' }],
    });

    const renamed = patched[1].children![0];
    expect(renamed).toMatchObject({
      name: 'new',
      title: '旧章',
      path: 'docs/dir/new.md',
      url: '/docs/o/r/dir/new',
    });
    // 兄弟节点与顺序不变
    expect(patched[0].path).toBe('docs/a.md');
    expect(patched[1].children![1].path).toBe('docs/dir/kept.md');
    // 原树不被修改
    expect(tree[1].children![0].path).toBe('docs/dir/old.md');
  });

  it('未命中路径的 rename 是安全空操作', () => {
    const tree: NavNode[] = [{ name: 'a', title: 'A', type: 'file', path: 'docs/a.md', url: '/docs/o/r/a' }];
    const patched = patchNavTree(tree, {
      remove: [],
      add: [],
      rename: [{ from: 'docs/missing.md', to: 'docs/x.md', toUrl: '/docs/o/r/x' }],
    });
    expect(patched).toEqual(tree);
  });
});
