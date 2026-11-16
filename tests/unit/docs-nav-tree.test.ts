import { describe, it, expect } from 'vitest';
import { buildFumadocsPageTree, mapOutlineToPageTree } from '@/lib/docs/docs-nav-tree';
import type { OutlineView } from '@/lib/outline-reader';
import { WEB_DOC_OWNER } from '@/lib/constants';

describe('docs-nav-tree unicode & emoji safety', () => {
  it('preserves multi-byte emojis (e.g. 👋🏽) and does not split surrogate pairs', () => {
    const mockOutline: OutlineView = {
      outlineId: 'test-outline',
      version: 1,
      mode: 'tutorial',
      parts: [],
      chapters: [
        {
          id: 'ch-welcome',
          title: '👋🏽 Welcome',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [
            {
              id: 'node-welcome',
              title: '👋🏽 Welcome',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'doc-welcome',
              docPath: 'welcome.md',
              docStatus: 'PROCESSED',
            },
          ],
        },
      ],
    };

    const tree = mapOutlineToPageTree(mockOutline, 'owner', 'repo', new Set());
    expect(tree).toHaveLength(1);

    // Single node chapter maps directly to page node
    const pageNode = tree[0];
    expect(pageNode.type).toBe('page');
    // Props of SidebarProgressItem
    const itemProps = pageNode.name.props;
    expect(itemProps.title).toBe('👋🏽 Welcome');
    // Verify no lone surrogates (\ud83d or \udc4b) exist
    expect(itemProps.title.charCodeAt(0)).toBe(0xd83d);
    expect(itemProps.title.charCodeAt(1)).toBe(0xdc4b);
  });

  it('correctly strips 🔬 microscope prefix without mangling subsequent emojis', () => {
    const mockOutline: OutlineView = {
      outlineId: 'test-outline',
      version: 1,
      mode: 'tutorial',
      parts: [],
      chapters: [
        {
          id: 'ch-micro',
          title: '🔬 Deep Dive',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [
            {
              id: 'node-1',
              title: 'Part 1',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'doc-1',
              docPath: 'part1.md',
              docStatus: 'PROCESSED',
            },
            {
              id: 'node-2',
              title: '🚪 [advanced] Part 2',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'doc-2',
              docPath: 'part2.md',
              docStatus: 'PROCESSED',
            },
          ],
        },
      ],
    };

    const tree = mapOutlineToPageTree(mockOutline, 'owner', 'repo', new Set());
    expect(tree).toHaveLength(1);
    const folder = tree[0];
    expect(folder.type).toBe('folder');
    expect(folder.name).toBe('Deep Dive');
    expect(folder.children).toHaveLength(2);
    expect(folder.children[1].name.props.title).toBe('Part 2');
  });

  it('flattens outline chapters across parts directly in sidebar without folder nesting or separators for code repositories', () => {
    const mockOutline: OutlineView = {
      outlineId: 'test-outline-parts',
      version: 1,
      mode: 'tutorial',
      parts: [
        {
          id: 'part-1',
          title: 'Part 1: Overview & Architecture',
          summary: null,
          teachingOrder: 1,
          chapters: [
            {
              id: 'ch-1',
              title: 'Chapter 1: Intro',
              summary: null,
              chapterType: 'doc',
              teachingOrder: 1,
              nodes: [
                {
                  id: 'n-1',
                  title: 'Chapter 1: Intro',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'd-1',
                  docPath: 'chapters/01.mdx',
                  docStatus: 'PROCESSED',
                },
              ],
            },
          ],
        },
        {
          id: 'part-2',
          title: 'Part 2: Deep Dive Engine',
          summary: null,
          teachingOrder: 2,
          chapters: [
            {
              id: 'ch-2',
              title: 'Chapter 2: Engine Internals',
              summary: null,
              chapterType: 'doc',
              teachingOrder: 2,
              nodes: [
                {
                  id: 'n-2',
                  title: 'Chapter 2: Engine Internals',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'd-2',
                  docPath: 'chapters/02.mdx',
                  docStatus: 'PROCESSED',
                },
              ],
            },
          ],
        },
      ],
      chapters: [
        {
          id: 'ch-standalone',
          title: 'Standalone Guide',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 3,
          nodes: [
            {
              id: 'n-3',
              title: 'Standalone Guide',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-3',
              docPath: 'standalone.mdx',
              docStatus: 'PROCESSED',
            },
          ],
        },
      ],
    };

    // Code repository should flatten chapters cleanly without separators
    const tree = mapOutlineToPageTree(mockOutline, 'owner', 'repo', new Set());
    expect(tree).toHaveLength(3);

    // First chapter (teachingOrder: 1)
    expect(tree[0].type).toBe('page');
    expect(tree[0].name.props.title).toBe('Chapter 1: Intro');

    // Second chapter (teachingOrder: 2)
    expect(tree[1].type).toBe('page');
    expect(tree[1].name.props.title).toBe('Chapter 2: Engine Internals');

    // Trailing standalone chapter at end
    expect(tree[2].type).toBe('page');
    expect(tree[2].name.props.title).toBe('Standalone Guide');

    // WebDoc repository should project parts as separators matching original site layout
    const webDocTree = mapOutlineToPageTree(mockOutline, WEB_DOC_OWNER, 'repo', new Set());
    expect(webDocTree).toHaveLength(5);
    expect(webDocTree[0].type).toBe('separator');
    expect(webDocTree[0].name).toBe('Part 1: Overview & Architecture');
    expect(webDocTree[1].type).toBe('page');
    expect(webDocTree[1].name.props.title).toBe('Chapter 1: Intro');
    expect(webDocTree[2].type).toBe('separator');
    expect(webDocTree[2].name).toBe('Part 2: Deep Dive Engine');
    expect(webDocTree[3].type).toBe('page');
    expect(webDocTree[3].name.props.title).toBe('Chapter 2: Engine Internals');
    expect(webDocTree[4].type).toBe('page');
    expect(webDocTree[4].name.props.title).toBe('Standalone Guide');
  });

  it('places leading standalone chapter before part separator and part chapters strictly in teaching order for WebDoc', () => {
    const mockOutline: OutlineView = {
      outlineId: 'test-outline-intro',
      version: 1,
      mode: 'tutorial',
      parts: [
        {
          id: 'part-1',
          title: 'Part 1: Core',
          summary: null,
          teachingOrder: 2,
          chapters: [
            {
              id: 'ch-1',
              title: 'Chapter 1',
              summary: null,
              chapterType: 'doc',
              teachingOrder: 2,
              nodes: [
                {
                  id: 'n-1',
                  title: 'Chapter 1',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'd-1',
                  docPath: 'chapters/01.mdx',
                  docStatus: 'PROCESSED',
                },
              ],
            },
          ],
        },
      ],
      chapters: [
        {
          id: 'ch-intro',
          title: 'Preface & Setup',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [
            {
              id: 'n-intro',
              title: 'Preface & Setup',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-intro',
              docPath: 'intro.mdx',
              docStatus: 'PROCESSED',
            },
          ],
        },
      ],
    };

    const tree = mapOutlineToPageTree(mockOutline, WEB_DOC_OWNER, 'repo', new Set());
    expect(tree).toHaveLength(3);
    // Preface comes first because teachingOrder 1 < 2
    expect(tree[0].type).toBe('page');
    expect(tree[0].name.props.title).toBe('Preface & Setup');
    // Part separator comes next
    expect(tree[1].type).toBe('separator');
    expect(tree[1].name).toBe('Part 1: Core');
    // Part chapter comes third
    expect(tree[2].type).toBe('page');
    expect(tree[2].name.props.title).toBe('Chapter 1');

    // For code repository, chapters are flattened
    const codeTree = mapOutlineToPageTree(mockOutline, 'owner', 'repo', new Set());
    expect(codeTree).toHaveLength(2);
    expect(codeTree[0].type).toBe('page');
    expect(codeTree[0].name.props.title).toBe('Preface & Setup');
    expect(codeTree[1].type).toBe('page');
    expect(codeTree[1].name.props.title).toBe('Chapter 1');
  });

  it('buildFumadocsPageTree propagates isWebDoc prop to SidebarProgressItem via owner and repoProfile', () => {
    const sampleOutline: OutlineView = {
      outlineId: 'outline-webdoc-prop',
      version: 1,
      mode: 'tutorial',
      parts: [],
      chapters: [
        {
          id: 'ch-1',
          title: 'Getting Started',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [
            {
              id: 'n-1',
              title: 'Getting Started',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-1',
              docPath: 'docs/getting-started.md',
              docStatus: 'PROCESSED',
            },
          ],
        },
      ],
    };

    const webDocTree = buildFumadocsPageTree({
      outline: sampleOutline,
      navTree: [],
      owner: WEB_DOC_OWNER,
      repo: 'eve-dev',
      hotPaths: new Set(),
    });
    expect(webDocTree.children[0].name.props.isWebDoc).toBe(true);

    const profileWebTree = buildFumadocsPageTree({
      outline: null,
      navTree: [
        {
          id: 'nav-1',
          title: 'Intro',
          type: 'file',
          path: 'intro.md',
          status: 'PROCESSED',
        },
      ],
      owner: 'custom-org',
      repo: 'portal',
      hotPaths: new Set(),
      repoProfile: { sourceType: 'web' },
    });
    expect(profileWebTree.children[0].name.props.isWebDoc).toBe(true);

    const githubTree = buildFumadocsPageTree({
      outline: sampleOutline,
      navTree: [],
      owner: 'vercel',
      repo: 'ai',
      hotPaths: new Set(),
    });
    expect(githubTree.children[0].name.props.isWebDoc).toBe(false);
  });
});

