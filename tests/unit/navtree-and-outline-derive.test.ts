import { test, expect, describe, it } from 'vitest';
import { patchNavTree, NavNode, NavTreePatch } from '@/engine/navtree-patch';
import { outlineFromNavTree } from '@/lib/mcp/outline-derive';
import { shortHash, buildTreeCourseBatch, mergeTreeCoursesToSingleOutline } from '@/engine/tree-batch-utils';
import { buildFumadocsPageTree, mapOutlineToPageTree } from '@/lib/docs/docs-nav-tree';
import { type OutlineView } from '@/lib/outline-reader';
import { WEB_DOC_OWNER } from '@/lib/constants';
import { buildWebNavTree } from '@/engine/web-doc/structurizer';
import type { DocumentItem } from '@/engine/web-doc/types';

describe('navtree-patch & outline-derive & tree-outline-batch', () => {
  test('patchNavTree: 定点删除、根/嵌套插入、缺省追加与不可变性', () => {
    const initialTree: NavNode[] = [
      { name: '01-intro', title: '引言', type: 'file', path: 'docs/01-intro.md', url: '/docs/o/r/01-intro' },
      {
        name: 'guide',
        title: '核心指南',
        type: 'directory',
        path: 'docs/guide',
        url: '/docs/o/r/guide',
        children: [
          { name: 'basics', title: '基础', type: 'file', path: 'docs/guide/basics.md', url: '/docs/o/r/guide/basics' },
          { name: 'advanced', title: '进阶', type: 'file', path: 'docs/guide/advanced.md', url: '/docs/o/r/guide/advanced' },
        ],
      },
      { name: '99-summary', title: '总结', type: 'file', path: 'docs/99-summary.md', url: '/docs/o/r/99-summary' },
    ];
    const snapshot = JSON.parse(JSON.stringify(initialTree));

    const removed = patchNavTree(initialTree, { remove: ['docs/01-intro.md', 'docs/guide/basics.md'], add: [] });
    expect(removed).toHaveLength(2);
    expect(removed[0].children?.map((c) => c.path)).toEqual(['docs/guide/advanced.md']);

    const insertedRoot = patchNavTree(initialTree, {
      remove: [],
      add: [{ node: { name: '02-setup', title: '搭建', type: 'file', path: 'docs/02-setup.md', url: '' }, positionPath: 'docs/01-intro.md' }],
    });
    expect(insertedRoot.map((n) => n.path)).toEqual(['docs/01-intro.md', 'docs/02-setup.md', 'docs/guide', 'docs/99-summary.md']);

    const insertedNested = patchNavTree(initialTree, {
      remove: [],
      add: [{ node: { name: 'mid', title: '中级', type: 'file', path: 'docs/guide/mid.md', url: '' }, positionPath: 'docs/guide/basics.md' }],
    });
    expect(insertedNested[1].children?.map((c) => c.path)).toEqual(['docs/guide/basics.md', 'docs/guide/mid.md', 'docs/guide/advanced.md']);

    const appended = patchNavTree(initialTree, {
      remove: [],
      add: [
        { node: { name: 'a1', title: 'a1', type: 'file', path: 'docs/a1.md', url: '' } },
        { node: { name: 'a2', title: 'a2', type: 'file', path: 'docs/a2.md', url: '' }, positionPath: 'missing.md' },
      ],
    });
    expect(appended.slice(3).map((n) => n.path)).toEqual(['docs/a1.md', 'docs/a2.md']);
    expect(initialTree).toEqual(snapshot);
  });

  test('outlineFromNavTree: 嵌套树/平铺文件/空树/空目录派生不变量', () => {
    const collectPaths = (nodes: any[]): string[] => nodes.flatMap((n) => (n.type === 'file' ? [n.path] : collectPaths(n.children ?? [])));
    const nested = [
      {
        name: 'guide',
        title: 'Guide',
        type: 'directory',
        path: 'guide',
        children: [
          { name: 'intro.md', title: 'Intro', type: 'file', path: 'guide/intro.md', url: '/x' },
          { name: 'advanced', title: 'Advanced', type: 'directory', path: 'guide/advanced', children: [{ name: 'deep.md', title: 'Deep', type: 'file', path: 'guide/advanced/deep.md', url: '/y' }] },
        ],
      },
      { name: 'readme.md', title: 'Readme', type: 'file', path: 'readme.md', url: '/z' },
    ];
    const draft = outlineFromNavTree(nested as any);
    expect(draft.parts.map((p) => p.title)).toEqual(['Guide']);
    expect(draft.chapters.map((c) => c.title)).toEqual(['Intro', 'Advanced', 'Readme']);
    expect(draft.chapters.flatMap((c) => c.nodes.map((n) => n.sourcePath)).sort()).toEqual(collectPaths(nested).sort());

    const flat = outlineFromNavTree([{ type: 'file', path: 'chapters/01.mdx', title: '模块一' }, { type: 'file', path: 'chapters/02.mdx' }] as any);
    expect(flat.chapters.map((c) => c.title)).toEqual(['模块一', '02.mdx']);

    expect(outlineFromNavTree([])).toEqual({ parts: [], chapters: [] });
    const emptyDir = outlineFromNavTree([{ name: 'empty', title: 'Empty', type: 'directory', path: 'empty', children: [{ name: 'sub', title: 'Sub', type: 'directory', path: 'empty/sub', children: [] }] }] as any);
    expect(emptyDir.chapters).toEqual([]);
  });

  it('mergeTreeCoursesToSingleOutline & buildTreeCourseBatch 合并、阶段后缀清洗与短哈希', () => {
    const merged = mergeTreeCoursesToSingleOutline([
      {
        name: '模块 1: 架构',
        chapters: [{ name: '第 1 章:全景(入门)', files: [{ path: 'README.md', companionFiles: ['a.ts'] }] as any }],
      },
      { name: '空模块', chapters: [] },
      { name: '模块 2: 进阶', chapters: [{ name: '第 2 章: proxy （进阶）', title: '第 2 章: proxy （进阶）', files: ['proxy.go'] }] },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ name: '第 1 章:全景', partTitle: '模块 1: 架构' });
    expect(merged[0].files[0].companionFiles).toEqual(['a.ts']);
    expect(merged[1]).toMatchObject({ name: '第 2 章: proxy', title: '第 2 章: proxy', partTitle: '模块 2: 进阶' });
    expect(mergeTreeCoursesToSingleOutline([])).toEqual([]);

    const batch = buildTreeCourseBatch(
      [{ name: '第 1 章:总览', chapters: [{ name: 'a' }] }, { name: '第 2 章:pkg', chapters: [{ name: 'b' }] }],
      '第 1 章:总览'
    );
    expect(batch[0].edition).toBe('');
    expect(batch[1].edition).toMatch(/^ed_[0-9a-f]{8}$/);
    expect(shortHash('核心实现')).toBe(shortHash('核心实现'));
    expect(shortHash('核心实现')).not.toBe(shortHash('核心实现2'));
    expect(shortHash('')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('docs-nav-tree & docs-nav-tree-outline', () => {
  it('mapOutlineToPageTree: 多字节 emoji 安全、🔬前缀清理与 buildFumadocsPageTree isWebDoc 传递', () => {
    const emojiOutline: OutlineView = {
      outlineId: 'o1',
      version: 1,
      mode: 'tutorial',
      parts: [],
      chapters: [
        {
          id: 'ch-w',
          title: '👋🏽 Welcome',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [{ id: 'n1', title: '👋🏽 Welcome', nodeType: 'doc', headingPath: null, documentId: 'd1', docPath: 'welcome.md', docStatus: 'PROCESSED' }],
        },
        {
          id: 'ch-m',
          title: '🔬 Deep Dive',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 2,
          nodes: [
            { id: 'n2', title: 'Part 1', nodeType: 'doc', headingPath: null, documentId: 'd2', docPath: 'p1.md', docStatus: 'PROCESSED' },
            { id: 'n3', title: '🚪 [advanced] Part 2', nodeType: 'doc', headingPath: null, documentId: 'd3', docPath: 'p2.md', docStatus: 'PROCESSED' },
          ],
        },
      ],
    };
    const tree = mapOutlineToPageTree(emojiOutline, 'owner', 'repo', new Set());
    expect(tree[0].name.props.title).toBe('👋🏽 Welcome');
    expect(tree[0].name.props.title.charCodeAt(0)).toBe(0xd83d);
    expect(tree[1]).toMatchObject({ type: 'folder', name: 'Deep Dive' });
    expect(tree[1].children[1].name.props.title).toBe('Part 2');

    expect(
      buildFumadocsPageTree({ outline: emojiOutline, navTree: [], owner: WEB_DOC_OWNER, repo: 'eve', hotPaths: new Set() }).children[0].name.props.isWebDoc
    ).toBe(true);
    expect(
      buildFumadocsPageTree({
        outline: null,
        navTree: [{ id: '1', title: 'Intro', type: 'file', path: 'intro.md', status: 'PROCESSED' }],
        owner: 'org',
        repo: 'portal',
        hotPaths: new Set(),
        repoProfile: { sourceType: 'web' },
      }).children[0].name.props.isWebDoc
    ).toBe(true);
    expect(buildFumadocsPageTree({ outline: emojiOutline, navTree: [], owner: 'vercel', repo: 'ai', hotPaths: new Set() }).children[0].name.props.isWebDoc).toBe(
      false
    );
  });

  it('mapOutlineToPageTree: Code 仓扁平化 vs WebDoc 分割线、穿插教学序与 folder.index 投影', () => {
    const outline: OutlineView = {
      outlineId: 'interleaved',
      version: 1,
      mode: 'tutorial',
      parts: [
        {
          id: 'p1',
          title: 'Part 1: Foundations',
          summary: null,
          teachingOrder: 1,
          chapters: [
            {
              id: 'c2',
              title: 'Chapter 2: Basics',
              summary: null,
              chapterType: 'doc',
              teachingOrder: 2,
              nodes: [{ id: 'n2', title: 'Chapter 2', nodeType: 'doc', headingPath: null, documentId: 'd2', docPath: 'docs/basics.md', docStatus: 'PROCESSED' }],
            },
          ],
        },
        {
          id: 'p2',
          title: 'Part 2: Advanced',
          summary: null,
          teachingOrder: 2,
          chapters: [
            {
              id: 'c4',
              title: 'Chapter 4: Internals',
              summary: null,
              chapterType: 'doc',
              teachingOrder: 4,
              nodes: [{ id: 'n4', title: 'Chapter 4', nodeType: 'doc', headingPath: null, documentId: 'd4', docPath: 'docs/internals.md', docStatus: 'PROCESSED' }],
            },
          ],
        },
      ],
      chapters: [
        {
          id: 'c1',
          title: 'Preface',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [{ id: 'n1', title: 'Preface', nodeType: 'doc', headingPath: null, documentId: 'd1', docPath: 'docs/preface.md', docStatus: 'PROCESSED' }],
        },
        {
          id: 'c3',
          title: 'Interlude',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 3,
          nodes: [{ id: 'n3', title: 'Interlude', nodeType: 'doc', headingPath: null, documentId: 'd3', docPath: 'docs/interlude.md', docStatus: 'PROCESSED' }],
        },
      ],
    };

    expect(mapOutlineToPageTree(outline, 'owner', 'repo', new Set()).map((n) => n.name.props.title)).toEqual([
      'Preface',
      'Chapter 2: Basics',
      'Interlude',
      'Chapter 4: Internals',
    ]);
    const webTree = mapOutlineToPageTree(outline, WEB_DOC_OWNER, 'repo', new Set());
    expect(webTree.map((n) => `${n.type}:${n.type === 'separator' ? n.name : n.name.props.title}`)).toEqual([
      'page:Preface',
      'separator:Part 1: Foundations',
      'page:Chapter 2: Basics',
      'page:Interlude',
      'separator:Part 2: Advanced',
      'page:Chapter 4: Internals',
    ]);

    const folderOutline: OutlineView = {
      outlineId: 'fi',
      version: 1,
      mode: 'tutorial',
      parts: [
        {
          id: 'pb',
          title: 'Build',
          summary: null,
          teachingOrder: 1,
          chapters: [
            {
              id: 'ch',
              title: 'Channels',
              summary: null,
              chapterType: 'doc',
              teachingOrder: 1,
              nodes: [
                { id: 'nc', title: 'Channels', nodeType: 'doc', headingPath: null, documentId: 'dc', docPath: 'docs/channels.md', docStatus: 'PROCESSED' },
                { id: 'nw', title: 'WhatsApp', nodeType: 'doc', headingPath: null, documentId: 'dw', docPath: 'docs/channels/wa.md', docStatus: 'PROCESSED' },
                { id: 'nt', title: 'Telegram', nodeType: 'doc', headingPath: null, documentId: 'dt', docPath: 'docs/channels/tg.md', docStatus: 'PROCESSED' },
              ],
            },
          ],
        },
      ],
      chapters: [],
    };
    const fTree = mapOutlineToPageTree(folderOutline, WEB_DOC_OWNER, 'eve-dev', new Set());
    expect(fTree[1]).toMatchObject({ type: 'folder', name: 'Channels', defaultOpen: false });
    expect(fTree[1].index.url).toBe(`/docs/${WEB_DOC_OWNER}/eve-dev/docs/channels`);
    expect(fTree[1].children).toHaveLength(2);
  });

  it('buildWebNavTree: priorityDoc 启发式、orderUrls 物理序优先与父索引/子页共存', () => {
    const doc = (path: string, title: string, url: string): DocumentItem => ({ path, title, markdown: '', url, contentHash: path, headings: [] });
    const docs = [doc('docs/add-integrations.md', 'Add', 'https://eve.dev/docs/add-integrations'), doc('docs/getting-started.md', 'Start', 'https://eve.dev/docs/getting-started')];
    expect(buildWebNavTree(docs).find((n) => n.name === 'docs')?.children?.map((c) => c.name)).toEqual(['getting-started', 'add-integrations']);
    expect(
      buildWebNavTree(docs, { orderUrls: ['https://eve.dev/docs/add-integrations', 'https://eve.dev/docs/getting-started'] })
        .find((n) => n.name === 'docs')
        ?.children?.map((c) => c.name)
    ).toEqual(['add-integrations', 'getting-started']);

    const p = doc('docs/channels/chat-sdk.md', 'Chat SDK', 'https://eve.dev/docs/channels/chat-sdk');
    const c = doc('docs/channels/chat-sdk/reference.md', 'Chat SDK Ref', 'https://eve.dev/docs/channels/chat-sdk/reference');
    for (const pair of [[p, c], [c, p]]) {
      const ch = outlineFromNavTree(buildWebNavTree(pair) as any).chapters.find((x) => x.title === 'Channels')!;
      expect(ch.nodes.map((n) => n.sourcePath)).toEqual(expect.arrayContaining(['docs/channels/chat-sdk.md', 'docs/channels/chat-sdk/reference.md']));
    }
  });
});
