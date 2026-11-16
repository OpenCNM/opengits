import { test, expect, describe } from 'vitest';
import { patchNavTree, NavNode, NavTreePatch } from '@/engine/navtree-patch';

describe('navtree-patch 导航树定点插删', () => {
  const initialTree: NavNode[] = [
    {
      name: '01-intro',
      title: '引言与起步',
      type: 'file',
      path: 'docs/01-intro.md',
      url: '/docs/owner/repo/01-intro',
    },
    {
      name: 'guide',
      title: '核心指南',
      type: 'directory',
      path: 'docs/guide',
      url: '/docs/owner/repo/guide',
      children: [
        {
          name: 'basics',
          title: '基础概念',
          type: 'file',
          path: 'docs/guide/basics.md',
          url: '/docs/owner/repo/guide/basics',
        },
        {
          name: 'advanced',
          title: '高级进阶',
          type: 'file',
          path: 'docs/guide/advanced.md',
          url: '/docs/owner/repo/guide/advanced',
        },
      ],
    },
    {
      name: '99-summary',
      title: '总结与结语',
      type: 'file',
      path: 'docs/99-summary.md',
      url: '/docs/owner/repo/99-summary',
    },
  ];

  test('remove：定点删除根节点与嵌套子节点，保持其余节点顺序', () => {
    const patch: NavTreePatch = {
      remove: ['docs/01-intro.md', 'docs/guide/basics.md'],
      add: [],
    };

    const newTree = patchNavTree(initialTree, patch);
    expect(newTree).toHaveLength(2);
    expect(newTree[0].path).toBe('docs/guide');
    expect(newTree[0].children).toHaveLength(1);
    expect(newTree[0].children![0].path).toBe('docs/guide/advanced.md');
    expect(newTree[1].path).toBe('docs/99-summary.md');
  });

  test('add：指定 positionPath 定点插入到根节点之后', () => {
    const newNode: NavNode = {
      name: '02-setup',
      title: '环境搭建',
      type: 'file',
      path: 'docs/02-setup.md',
      url: '/docs/owner/repo/02-setup',
    };

    const patch: NavTreePatch = {
      remove: [],
      add: [{ node: newNode, positionPath: 'docs/01-intro.md' }],
    };

    const newTree = patchNavTree(initialTree, patch);
    expect(newTree).toHaveLength(4);
    expect(newTree[0].path).toBe('docs/01-intro.md');
    expect(newTree[1].path).toBe('docs/02-setup.md');
    expect(newTree[2].path).toBe('docs/guide');
    expect(newTree[3].path).toBe('docs/99-summary.md');
  });

  test('add：指定 positionPath 定点插入到嵌套子节点之后', () => {
    const nestedNode: NavNode = {
      name: 'intermediate',
      title: '中级实战',
      type: 'file',
      path: 'docs/guide/intermediate.md',
      url: '/docs/owner/repo/guide/intermediate',
    };

    const patch: NavTreePatch = {
      remove: [],
      add: [{ node: nestedNode, positionPath: 'docs/guide/basics.md' }],
    };

    const newTree = patchNavTree(initialTree, patch);
    const guideDir = newTree.find((n) => n.path === 'docs/guide');
    expect(guideDir?.children).toHaveLength(3);
    expect(guideDir?.children![0].path).toBe('docs/guide/basics.md');
    expect(guideDir?.children![1].path).toBe('docs/guide/intermediate.md');
    expect(guideDir?.children![2].path).toBe('docs/guide/advanced.md');
  });

  test('add：缺失 positionPath 或找不到锚点时追加到根列表末尾', () => {
    const fallbackNode1: NavNode = {
      name: 'append1',
      title: '追加1',
      type: 'file',
      path: 'docs/append1.md',
      url: '/docs/owner/repo/append1',
    };
    const fallbackNode2: NavNode = {
      name: 'append2',
      title: '追加2',
      type: 'file',
      path: 'docs/append2.md',
      url: '/docs/owner/repo/append2',
    };

    const patch: NavTreePatch = {
      remove: [],
      add: [
        { node: fallbackNode1 }, // 无 positionPath
        { node: fallbackNode2, positionPath: 'non-existent-path.md' }, // 锚点不存在
      ],
    };

    const newTree = patchNavTree(initialTree, patch);
    expect(newTree).toHaveLength(5);
    expect(newTree[3].path).toBe('docs/append1.md');
    expect(newTree[4].path).toBe('docs/append2.md');
  });

  test('不可变性（Immutability）：原树数组与嵌套子数组不被原地修改', () => {
    const treeCopy = JSON.parse(JSON.stringify(initialTree));
    patchNavTree(initialTree, {
      remove: ['docs/01-intro.md'],
      add: [
        {
          node: {
            name: 'new',
            title: 'new',
            type: 'file',
            path: 'docs/new.md',
            url: '',
          },
        },
      ],
    });

    expect(initialTree).toEqual(treeCopy);
  });
});
