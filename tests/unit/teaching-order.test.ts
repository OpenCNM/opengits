import { test, expect, describe, vi, beforeEach } from 'vitest';

/**
 * 大纲双轨收敛统一读入口（lib/outline-reader）单测：
 * - flattenNavTreeEntries / flattenNavTreeFiles：V1 navTree 展平唯一实现
 * - outlineTeachingDocPaths：V2 教学顺序展平（大类与顶层章混排、docPath 去重）
 * - resolveTeachingDocPaths：全仓唯一 V2→V1 兜底链（含读取失败静默降级）
 */
const mockCallSidecar = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => mockCallSidecar(...args),
}));

vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    tutorialOutline: { findFirst: vi.fn() },
    repository: { findUnique: vi.fn() },
  },
}));

const {
  flattenNavTreeEntries,
  outlineTeachingDocPaths,
  resolveTeachingDocPaths,
} = await import('@/lib/outline-reader');
const { prisma } = await import('@/lib/db');

const navTree = [
  {
    name: 'book', title: '教程目录', type: 'directory' as const, path: 'book', url: '/docs/o/r/book',
    children: [
      { name: 'intro.md', title: '入门', shortTitle: 'Intro', type: 'file' as const, path: 'book/intro.md', url: '/docs/o/r/book/intro' },
      {
        name: 'advanced', title: '进阶', type: 'directory' as const, path: 'book/advanced', url: '/docs/o/r/book/advanced',
        children: [
          { name: 'deep.md', title: '深入', type: 'file' as const, path: 'book/advanced/deep.md', url: '/docs/o/r' },
        ],
      },
    ],
  },
  { name: 'readme.md', title: 'README', type: 'file' as const, path: 'readme.md', url: '/docs/o/r' },
];

describe('flattenNavTreeEntries（V1 展平唯一实现）', () => {
  test('深度优先收集 file 节点，跳过 directory 本身', () => {
    const entries = flattenNavTreeEntries(navTree as never);
    expect(entries.map((e) => e.path)).toEqual(['book/intro.md', 'book/advanced/deep.md', 'readme.md']);
  });

  test('显示名规约：shortTitle → title → path', () => {
    const entries = flattenNavTreeEntries(navTree as never);
    expect(entries[0].title).toBe('Intro'); // shortTitle 优先
    expect(entries[2].title).toBe('README');
  });

  test('null / undefined 输入安全返回空数组', () => {
    expect(flattenNavTreeEntries(undefined)).toEqual([]);
    expect(flattenNavTreeEntries(null)).toEqual([]);
    // flattenNavTreeFiles 已收窄为私有（路径投影 = entries.map(e => e.path)），经 entries 表面断言
    expect(flattenNavTreeEntries(undefined).map((e) => e.path)).toEqual([]);
  });
});

describe('outlineTeachingDocPaths（V2 教学顺序展平）', () => {
  test('顶层章与大类章按 teachingOrder 混排，跳过无 docPath 节点并去重', () => {
    const outline = {
      outlineId: 'o1', version: 1, mode: 'tutorial',
      parts: [
        {
          id: 'p1', title: '第一部分', summary: null, teachingOrder: 1,
          chapters: [
            {
              id: 'c2', title: '第二章', summary: null, chapterType: 'doc', moduleName: null, teachingOrder: 2,
              nodes: [
                { id: 'n3', title: '节A', nodeType: 'doc', headingPath: null, documentId: 'd3', docPath: 'docs/b.md', docStatus: 'PROCESSED' },
                { id: 'n4', title: '未建文档节', nodeType: 'doc', headingPath: null, documentId: 'd4', docPath: null, docStatus: null },
              ],
            },
          ],
        },
      ],
      chapters: [
        {
          id: 'c1', title: '第一章', summary: null, chapterType: 'doc', moduleName: null, teachingOrder: 1,
          nodes: [
            { id: 'n1', title: '节X', nodeType: 'doc', headingPath: null, documentId: 'd1', docPath: 'docs/a.md', docStatus: 'PROCESSED' },
            { id: 'n2', title: '节A镜像', nodeType: 'doc', headingPath: null, documentId: 'd2', docPath: 'docs/b.md', docStatus: 'PROCESSED' },
          ],
        },
      ],
    } as never;

    // teachingOrder 1 的顶层章在前；docs/b.md 去重保序；无 docPath 节点跳过
    expect(outlineTeachingDocPaths(outline)).toEqual(['docs/a.md', 'docs/b.md']);
  });
});

describe('resolveTeachingDocPaths（全仓唯一 V2→V1 兜底链）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('有激活大纲 → 走 V2 教学顺序', async () => {
    mockCallSidecar.mockResolvedValue({
      ok: true,
      outline: {
        outlineId: 'o1',
        version: 1,
        mode: 'tutorial',
        parts: [],
        chapters: [
          {
            id: 'c1',
            title: '章',
            summary: null,
            chapterType: 'doc',
            moduleName: null,
            teachingOrder: 1,
            nodes: [
              {
                id: 'n1',
                title: '节',
                nodeType: 'doc',
                headingPath: null,
                documentId: 'd1',
                docPath: 'docs/a.md',
                docStatus: 'PROCESSED',
              },
            ],
          },
        ],
      },
    });

    const paths = await resolveTeachingDocPaths('repo-1', navTree);
    expect(paths).toEqual(['docs/a.md']); // V2 命中，不落 V1
  });

  test('无激活大纲（存量老仓库）→ 兜底 V1 navTree 深度优先', async () => {
    mockCallSidecar.mockResolvedValue({ ok: true, outline: null });
    const paths = await resolveTeachingDocPaths('repo-1', navTree);
    expect(paths).toEqual(['book/intro.md', 'book/advanced/deep.md', 'readme.md']);
  });

  test('大纲读取异常 → 静默降级 V1，不向调用方抛错', async () => {
    mockCallSidecar.mockRejectedValue(new Error('sidecar down'));
    const paths = await resolveTeachingDocPaths('repo-1', navTree);
    expect(paths).toEqual(['book/intro.md', 'book/advanced/deep.md', 'readme.md']);
  });

  test('两者皆无 → 空数组（调用方自行按 createdAt 兜底）', async () => {
    mockCallSidecar.mockResolvedValue({ ok: true, outline: null });
    expect(await resolveTeachingDocPaths('repo-1', undefined)).toEqual([]);
  });
});
