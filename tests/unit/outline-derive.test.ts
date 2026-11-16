import { describe, test, expect } from 'vitest';
import { outlineFromNavTree } from '@/lib/mcp/outline-derive';

/** 递归收集 navTree 内全部文件路径（测试对照基准） */
function collectPaths(nodes: any[]): string[] {
  return nodes.flatMap((n) =>
    n.type === 'file' ? [n.path] : collectPaths(n.children ?? []),
  );
}

describe('outlineFromNavTree navTree → 大纲确定性派生', () => {
  test('1.11.1.1 嵌套树：顶层目录→大类，二级子项→章，全部文件无遗漏', () => {
    const navTree = [
      {
        name: 'guide', title: 'Guide', type: 'directory', path: 'guide',
        children: [
          { name: 'intro.md', title: 'Intro', type: 'file', path: 'guide/intro.md', url: '/x' },
          {
            name: 'advanced', title: 'Advanced', type: 'directory', path: 'guide/advanced',
            children: [
              { name: 'deep.md', title: 'Deep', type: 'file', path: 'guide/advanced/deep.md', url: '/y' },
            ],
          },
        ],
      },
      { name: 'readme.md', title: 'Readme', type: 'file', path: 'readme.md', url: '/z' },
    ];

    const draft = outlineFromNavTree(navTree as any);

    // 大类 = 顶层目录；章 = 二级子项（guide/intro、guide/advanced）+ 顶层文件（readme）
    expect(draft.parts.map((p) => p.title)).toEqual(['Guide']);
    expect(draft.chapters.map((c) => c.title)).toEqual(['Intro', 'Advanced', 'Readme']);
    // teachingOrder 连续
    expect(draft.chapters.map((c) => c.teachingOrder)).toEqual([1, 2, 3]);
    // 章 → 大类归属
    expect(draft.chapters.map((c) => c.partTitle)).toEqual(['Guide', 'Guide', undefined]);
    // 覆盖不变量：派生大纲的文件集合与 navTree 完全一致（绝不漏文件）
    const outlinePaths = draft.chapters.flatMap((c) => c.nodes.map((n) => n.sourcePath)).sort();
    expect(outlinePaths).toEqual(collectPaths(navTree).sort());
    // 深层文件收进所在二级目录的章
    expect(draft.chapters[1].nodes.map((n) => n.sourcePath)).toEqual(['guide/advanced/deep.md']);
  });

  test('1.11.3.1 平铺文件列表（code 引擎模块章形态）：每文件一章，title 缺省回退路径末段', () => {
    const navTree = [
      { type: 'file', path: 'chapters/01.mdx', title: '模块一', url: '/docs/o/r/chapters/01' },
      { type: 'file', path: 'chapters/02.mdx', url: '/docs/o/r/chapters/02' },
    ];

    const draft = outlineFromNavTree(navTree as any);

    expect(draft.parts).toEqual([]);
    expect(draft.chapters.map((c) => c.title)).toEqual(['模块一', '02.mdx']);
    expect(draft.chapters.flatMap((c) => c.nodes.map((n) => n.sourcePath)))
      .toEqual(['chapters/01.mdx', 'chapters/02.mdx']);
  });

  test('1.11.2.1 空树产出空大纲（调用方 try/catch 兜底，不阻断导入）', () => {
    const draft = outlineFromNavTree([]);
    expect(draft.parts).toEqual([]);
    expect(draft.chapters).toEqual([]);
  });

  test('空目录不产出空章', () => {
    const navTree = [
      {
        name: 'empty', title: 'Empty', type: 'directory', path: 'empty',
        children: [
          { name: 'sub', title: 'Sub', type: 'directory', path: 'empty/sub', children: [] },
        ],
      },
    ];
    const draft = outlineFromNavTree(navTree as any);
    expect(draft.parts.map((p) => p.title)).toEqual(['Empty']);
    expect(draft.chapters).toEqual([]);
  });
});
