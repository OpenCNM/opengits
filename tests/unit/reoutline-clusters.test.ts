import { describe, it, expect } from 'vitest';
import { orchestrateFromClusters } from '@/lib/mcp/ingest-orchestrator';
import { chapterDocPath } from '@/lib/constants';

describe('orchestrateFromClusters', () => {
  it('preserves partTitle and populates distinct parts', () => {
    const chapters = [
      { title: 'Overview', teachingOrder: 1, partTitle: 'Part 1: Getting Started' },
      { title: 'Setup', teachingOrder: 2, partTitle: 'Part 1: Getting Started' },
      { title: 'Core Concepts', teachingOrder: 3, partTitle: 'Part 2: Deep Dive' },
      { title: 'Advanced Storage', teachingOrder: 4, partTitle: 'Part 2: Deep Dive' },
    ];

    const draft = orchestrateFromClusters(chapters);

    expect(draft.parts).toEqual([
      { title: 'Part 1: Getting Started', teachingOrder: 1 },
      { title: 'Part 2: Deep Dive', teachingOrder: 3 },
    ]);
    expect(draft.chapters).toHaveLength(4);
    expect(draft.chapters[0]).toMatchObject({
      title: 'Overview',
      partTitle: 'Part 1: Getting Started',
      chapterType: 'code',
      teachingOrder: 1,
      nodes: [{ sourcePath: chapterDocPath(1), title: 'Overview', nodeType: 'code' }],
    });
    expect(draft.chapters[2]).toMatchObject({
      title: 'Core Concepts',
      partTitle: 'Part 2: Deep Dive',
      chapterType: 'code',
      teachingOrder: 3,
      nodes: [{ sourcePath: chapterDocPath(3), title: 'Core Concepts', nodeType: 'code' }],
    });
  });

  it('runs ensurePartsIfLarge when chapters > 6 and no partTitle provided', () => {
    const chapters = Array.from({ length: 9 }, (_, i) => ({
      title: `Chapter ${i + 1}`,
      teachingOrder: i + 1,
    }));

    const draft = orchestrateFromClusters(chapters);

    expect(draft.parts).toHaveLength(3);
    expect(draft.parts.map((p) => p.title)).toEqual(['Basics', 'Core', 'Advanced']);
    expect(draft.chapters[0].partTitle).toBe('Basics');
    expect(draft.chapters[3].partTitle).toBe('Core');
    expect(draft.chapters[6].partTitle).toBe('Advanced');
  });

  it('preserves appendix documents without dropping or duplicating cluster documents', () => {
    const clusters = [
      { title: 'Module A', teachingOrder: 1, partTitle: 'Part 1' },
      { title: 'Module B', teachingOrder: 2, partTitle: 'Part 1' },
    ];

    const draft = orchestrateFromClusters(clusters);

    const docs = [
      { id: 'd1', path: chapterDocPath(1), title: 'Module A' },
      { id: 'd2', path: chapterDocPath(2), title: 'Module B' },
      { id: 'd3', path: 'docs/architecture.md', title: 'Architecture Overview' },
      { id: 'd4', path: 'README.md', title: null },
    ];

    const clusterDocPaths = new Set(
      draft.chapters.flatMap((ch) => ch.nodes.map((n) => n.sourcePath)),
    );
    const appendixDocs = docs.filter((d) => !clusterDocPaths.has(d.path));

    expect(appendixDocs).toHaveLength(2);
    expect(appendixDocs.map((d) => d.path)).toEqual(['docs/architecture.md', 'README.md']);

    let nextOrder = draft.chapters.length;
    for (const doc of appendixDocs) {
      nextOrder += 1;
      const fileName = doc.path.split('/').pop() || doc.path;
      const docTitle = doc.title || fileName.replace(/\.(md|mdx|markdown)$/i, '');
      const formattedTitle =
        doc.title || docTitle.charAt(0).toUpperCase() + docTitle.slice(1).replace(/[-_]+/g, ' ');
      draft.chapters.push({
        title: formattedTitle,
        chapterType: 'doc',
        teachingOrder: nextOrder,
        nodes: [
          {
            sourcePath: doc.path,
            title: formattedTitle,
            nodeType: 'doc',
          },
        ],
      });
    }

    expect(draft.chapters).toHaveLength(4);
    expect(draft.chapters[2]).toMatchObject({
      title: 'Architecture Overview',
      chapterType: 'doc',
      teachingOrder: 3,
      nodes: [{ sourcePath: 'docs/architecture.md', title: 'Architecture Overview', nodeType: 'doc' }],
    });
    expect(draft.chapters[3]).toMatchObject({
      title: 'README',
      chapterType: 'doc',
      teachingOrder: 4,
      nodes: [{ sourcePath: 'README.md', title: 'README', nodeType: 'doc' }],
    });
  });
});
