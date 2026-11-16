import { describe, it, expect } from 'vitest';
import { mapOutlineToPageTree } from '@/lib/docs/docs-nav-tree';
import type { OutlineView } from '@/lib/outline-reader';
import { buildWebNavTree } from '@/engine/web-doc/structurizer';
import { outlineFromNavTree } from '@/lib/mcp/outline-derive';
import { WEB_DOC_OWNER } from '@/lib/constants';
import type { DocumentItem } from '@/engine/web-doc/types';

describe('docs-nav-tree-outline blueprint & separator projection', () => {
  it('projects parts to Fumadocs separators matching original site layout (Eve.dev 1:1)', () => {
    const mockOutline: OutlineView = {
      outlineId: 'eve-dev-outline',
      version: 1,
      mode: 'tutorial',
      parts: [
        {
          id: 'part-intro',
          title: 'Introduction',
          summary: null,
          teachingOrder: 1,
          chapters: [
            {
              id: 'ch-getting-started',
              title: 'Getting Started',
              summary: null,
              chapterType: 'doc',
              teachingOrder: 1,
              nodes: [
                {
                  id: 'n-gs',
                  title: 'Getting Started',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'd-gs',
                  docPath: 'docs/getting-started.md',
                  docStatus: 'PROCESSED',
                },
              ],
            },
            {
              id: 'ch-use-cases',
              title: 'Use Cases',
              summary: null,
              chapterType: 'doc',
              teachingOrder: 2,
              nodes: [
                {
                  id: 'n-uc',
                  title: 'Use Cases',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'd-uc',
                  docPath: 'docs/use-cases.md',
                  docStatus: 'PROCESSED',
                },
              ],
            },
          ],
        },
        {
          id: 'part-build',
          title: 'Build',
          summary: null,
          teachingOrder: 2,
          chapters: [
            {
              id: 'ch-channels',
              title: 'Channels',
              summary: null,
              chapterType: 'doc',
              teachingOrder: 3,
              nodes: [
                {
                  id: 'n-wa',
                  title: 'WhatsApp',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'd-wa',
                  docPath: 'docs/channels/whatsapp.md',
                  docStatus: 'PROCESSED',
                },
                {
                  id: 'n-tg',
                  title: 'Telegram',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'd-tg',
                  docPath: 'docs/channels/telegram.md',
                  docStatus: 'PROCESSED',
                },
              ],
            },
            {
              id: 'ch-extensions',
              title: 'Extensions',
              summary: null,
              chapterType: 'doc',
              teachingOrder: 4,
              nodes: [
                {
                  id: 'n-ext',
                  title: 'Extensions',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'd-ext',
                  docPath: 'docs/extensions.md',
                  docStatus: 'PROCESSED',
                },
              ],
            },
          ],
        },
        {
          id: 'part-integrate',
          title: 'Integrate',
          summary: null,
          teachingOrder: 3,
          chapters: [
            {
              id: 'ch-add-integrations',
              title: 'Add Integrations',
              summary: null,
              chapterType: 'doc',
              teachingOrder: 5,
              nodes: [
                {
                  id: 'n-ai',
                  title: 'Add Integrations',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'd-ai',
                  docPath: 'docs/add-integrations.md',
                  docStatus: 'PROCESSED',
                },
              ],
            },
            {
              id: 'ch-webhooks',
              title: 'Webhooks',
              summary: null,
              chapterType: 'doc',
              teachingOrder: 6,
              nodes: [
                {
                  id: 'n-wh',
                  title: 'Webhooks',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'd-wh',
                  docPath: 'docs/webhooks.md',
                  docStatus: 'PROCESSED',
                },
              ],
            },
          ],
        },
      ],
      chapters: [],
    };

    const tree = mapOutlineToPageTree(mockOutline, WEB_DOC_OWNER, 'eve-dev', new Set());

    // 3 separators + 2 intro pages + 1 folder (channels) + 1 page (extensions) + 2 integrate pages = 9 items
    expect(tree).toHaveLength(9);

    // Section 1: Introduction
    expect(tree[0].type).toBe('separator');
    expect(tree[0].name).toBe('Introduction');

    expect(tree[1].type).toBe('page');
    expect(tree[1].name.props.title).toBe('Getting Started');

    expect(tree[2].type).toBe('page');
    expect(tree[2].name.props.title).toBe('Use Cases');

    // Section 2: Build
    expect(tree[3].type).toBe('separator');
    expect(tree[3].name).toBe('Build');

    expect(tree[4].type).toBe('folder');
    expect(tree[4].name).toBe('Channels');
    expect(tree[4].children).toHaveLength(2);
    expect(tree[4].children[0].name.props.title).toBe('WhatsApp');
    expect(tree[4].children[1].name.props.title).toBe('Telegram');

    expect(tree[5].type).toBe('page');
    expect(tree[5].name.props.title).toBe('Extensions');

    // Section 3: Integrate
    expect(tree[6].type).toBe('separator');
    expect(tree[6].name).toBe('Integrate');

    expect(tree[7].type).toBe('page');
    expect(tree[7].name.props.title).toBe('Add Integrations');

    expect(tree[8].type).toBe('page');
    expect(tree[8].name.props.title).toBe('Webhooks');
  });

  it('renders flat list without separators when parts is empty', () => {
    const mockOutline: OutlineView = {
      outlineId: 'flat-outline',
      version: 1,
      mode: 'tutorial',
      parts: [],
      chapters: [
        {
          id: 'ch-1',
          title: 'Doc One',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1,
          nodes: [
            {
              id: 'n-1',
              title: 'Doc One',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-1',
              docPath: 'docs/doc1.md',
              docStatus: 'PROCESSED',
            },
          ],
        },
      ],
    };

    const tree = mapOutlineToPageTree(mockOutline, 'acme', 'repo', new Set());
    expect(tree).toHaveLength(1);
    expect(tree[0].type).toBe('page');
    expect(tree[0].name.props.title).toBe('Doc One');
  });

  it('buildWebNavTree prioritizes getting-started over add-integrations in fallback sorting', () => {
    const documents: DocumentItem[] = [
      {
        path: 'docs/add-integrations.md',
        title: 'Add Integrations',
        markdown: '',
        url: 'https://eve.dev/docs/add-integrations',
        contentHash: 'h1',
        headings: [],
      },
      {
        path: 'docs/getting-started.md',
        title: 'Getting Started',
        markdown: '',
        url: 'https://eve.dev/docs/getting-started',
        contentHash: 'h2',
        headings: [],
      },
    ];

    // 无 orderUrls 时，getting-started 仍然凭借 priorityDoc 置顶，不会因字母序 a < g 颠倒
    const tree = buildWebNavTree(documents);
    const docsFolder = tree.find((n) => n.name === 'docs');
    expect(docsFolder).toBeDefined();
    expect(docsFolder?.children?.[0].name).toBe('getting-started');
    expect(docsFolder?.children?.[1].name).toBe('add-integrations');
  });

  it('buildWebNavTree strictly honors orderUrls physical facts over priorityDoc heuristics', () => {
    const documents: DocumentItem[] = [
      {
        path: 'docs/getting-started.md',
        title: 'Getting Started',
        markdown: '',
        url: 'https://eve.dev/docs/getting-started',
        contentHash: 'h1',
        headings: [],
      },
      {
        path: 'docs/custom-overview.md',
        title: 'Custom Overview',
        markdown: '',
        url: 'https://eve.dev/docs/custom-overview',
        contentHash: 'h2',
        headings: [],
      },
    ];

    // 当源站物理侧栏明确指定 custom-overview 在前时，物理顺序优先于 priorityDoc 启发式
    const tree = buildWebNavTree(documents, {
      orderUrls: ['https://eve.dev/docs/custom-overview', 'https://eve.dev/docs/getting-started'],
    });
    const docsFolder = tree.find((n) => n.name === 'docs');
    expect(docsFolder).toBeDefined();
    expect(docsFolder?.children?.[0].name).toBe('custom-overview');
    expect(docsFolder?.children?.[1].name).toBe('getting-started');
  });

  it('interleaves standalone chapters and part separators strictly in teaching order', () => {
    const mockOutline: OutlineView = {
      outlineId: 'interleaved-outline',
      version: 1,
      mode: 'tutorial',
      parts: [
        {
          id: 'part-1',
          title: 'Part 1: Foundations',
          summary: null,
          teachingOrder: 1,
          chapters: [
            {
              id: 'ch-2',
              title: 'Chapter 2: Basics',
              summary: null,
              chapterType: 'doc',
              teachingOrder: 2,
              nodes: [
                {
                  id: 'n-2',
                  title: 'Chapter 2',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'd-2',
                  docPath: 'docs/basics.md',
                  docStatus: 'PROCESSED',
                },
              ],
            },
          ],
        },
        {
          id: 'part-2',
          title: 'Part 2: Advanced',
          summary: null,
          teachingOrder: 2,
          chapters: [
            {
              id: 'ch-4',
              title: 'Chapter 4: Internals',
              summary: null,
              chapterType: 'doc',
              teachingOrder: 4,
              nodes: [
                {
                  id: 'n-4',
                  title: 'Chapter 4',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'd-4',
                  docPath: 'docs/internals.md',
                  docStatus: 'PROCESSED',
                },
              ],
            },
          ],
        },
      ],
      chapters: [
        {
          id: 'ch-preface',
          title: 'Preface',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 1, // Same numerical order as part 1, but standalone preface precedes part separator
          nodes: [
            {
              id: 'n-preface',
              title: 'Preface',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-preface',
              docPath: 'docs/preface.md',
              docStatus: 'PROCESSED',
            },
          ],
        },
        {
          id: 'ch-interlude',
          title: 'Interlude',
          summary: null,
          chapterType: 'doc',
          teachingOrder: 3, // Sits exactly between Part 1 and Part 2
          nodes: [
            {
              id: 'n-interlude',
              title: 'Interlude',
              nodeType: 'doc',
              headingPath: null,
              documentId: 'd-interlude',
              docPath: 'docs/interlude.md',
              docStatus: 'PROCESSED',
            },
          ],
        },
      ],
    };

    const tree = mapOutlineToPageTree(mockOutline, WEB_DOC_OWNER, 'interleaved-repo', new Set());

    // Sequence must be:
    // 0: Preface (page)
    // 1: Part 1: Foundations (separator)
    // 2: Chapter 2: Basics (page)
    // 3: Interlude (page)
    // 4: Part 2: Advanced (separator)
    // 5: Chapter 4: Internals (page)
    expect(tree).toHaveLength(6);

    expect(tree[0].type).toBe('page');
    expect(tree[0].name.props.title).toBe('Preface');

    expect(tree[1].type).toBe('separator');
    expect(tree[1].name).toBe('Part 1: Foundations');

    expect(tree[2].type).toBe('page');
    expect(tree[2].name.props.title).toBe('Chapter 2: Basics');

    expect(tree[3].type).toBe('page');
    expect(tree[3].name.props.title).toBe('Interlude');

    expect(tree[4].type).toBe('separator');
    expect(tree[4].name).toBe('Part 2: Advanced');

    expect(tree[5].type).toBe('page');
    expect(tree[5].name.props.title).toBe('Chapter 4: Internals');
  });

  it('preserves parent index doc when coexisting with nested child path in both arrival orders', () => {
    const docParent: DocumentItem = {
      path: 'docs/channels/chat-sdk.md',
      title: 'Chat SDK',
      markdown: '',
      url: 'https://eve.dev/docs/channels/chat-sdk',
      contentHash: 'h1',
      headings: [],
    };
    const docChild: DocumentItem = {
      path: 'docs/channels/chat-sdk/reference.md',
      title: 'Chat SDK Reference',
      markdown: '',
      url: 'https://eve.dev/docs/channels/chat-sdk/reference',
      contentHash: 'h2',
      headings: [],
    };

    for (const docs of [
      [docParent, docChild],
      [docChild, docParent],
    ]) {
      const tree = buildWebNavTree(docs);
      const draft = outlineFromNavTree(tree as any);
      const channelsChapter = draft.chapters.find((c) => c.title === 'Channels');
      expect(channelsChapter).toBeDefined();
      const paths = channelsChapter!.nodes.map((n) => n.sourcePath);
      expect(paths).toContain('docs/channels/chat-sdk.md');
      expect(paths).toContain('docs/channels/chat-sdk/reference.md');
    }
  });

  it('projects folder.index and collapsed defaultOpen for webdoc folder chapters with matching index page', () => {
    const mockOutline: OutlineView = {
      outlineId: 'webdoc-folder-index',
      version: 1,
      mode: 'tutorial',
      parts: [
        {
          id: 'p-build',
          title: 'Build',
          summary: null,
          teachingOrder: 1,
          chapters: [
            {
              id: 'ch-channels',
              title: 'Channels',
              summary: null,
              chapterType: 'doc',
              teachingOrder: 1,
              nodes: [
                {
                  id: 'n-channels',
                  title: 'Channels',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'd-channels',
                  docPath: 'docs/channels.md',
                  docStatus: 'PROCESSED',
                },
                {
                  id: 'n-chat-sdk',
                  title: 'Chat SDK',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'd-chat-sdk',
                  docPath: 'docs/channels/chat-sdk.md',
                  docStatus: 'PROCESSED',
                },
                {
                  id: 'n-chat-sdk-ref',
                  title: 'Chat SDK Reference',
                  nodeType: 'doc',
                  headingPath: null,
                  documentId: 'd-chat-sdk-ref',
                  docPath: 'docs/channels/chat-sdk/reference.md',
                  docStatus: 'PROCESSED',
                },
              ],
            },
          ],
        },
      ],
      chapters: [],
    };

    const tree = mapOutlineToPageTree(mockOutline, WEB_DOC_OWNER, 'eve-dev', new Set());
    expect(tree).toHaveLength(2);
    expect(tree[0].type).toBe('separator');
    expect(tree[0].name).toBe('Build');

    const folder = tree[1];
    expect(folder.type).toBe('folder');
    expect(folder.name).toBe('Channels');
    expect(folder.defaultOpen).toBe(false);
    expect(folder.index).toBeDefined();
    expect(folder.index.url).toBe(`/docs/${WEB_DOC_OWNER}/eve-dev/docs/channels`);
    expect(folder.children).toHaveLength(2);
    expect(folder.children[0].name.props.title).toBe('Chat SDK');
    expect(folder.children[1].name.props.title).toBe('Chat SDK Reference');
  });
});
