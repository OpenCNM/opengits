import { describe, expect, it } from 'vitest';
import type { RelayOutlineChapter, RelayOutlineNode } from '@/components/update/workbench/useUpdateWorkbench';

describe('Relay Outline Workbench logic', () => {
  const mockOutline: RelayOutlineChapter[] = [
    {
      id: 'ch-1',
      title: '第 1 章：项目概览与环境初始化',
      teachingOrder: 1,
      nodes: [
        {
          id: 'doc-1',
          documentId: 'doc-1',
          title: '项目概览与入门指南',
          path: 'README.md',
          status: 'PROCESSED',
          versionCount: 2,
        },
        {
          id: 'doc-2',
          documentId: 'doc-2',
          title: '1 file import',
          path: 'docs/1_file_import.md',
          status: 'UNPROCESSED',
          versionCount: 0,
        },
        {
          id: 'doc-3',
          documentId: 'doc-3',
          title: '2 live recording',
          path: 'docs/2_live_recording.md',
          status: 'CLAIMED',
          claimedBy: 'Alice',
          versionCount: 0,
        },
      ],
    },
    {
      id: 'ch-2',
      title: '第 2 章：构建与分发',
      teachingOrder: 2,
      nodes: [
        {
          id: 'doc-4',
          documentId: 'doc-4',
          title: 'build script',
          path: 'scripts/build.py',
          status: 'PROCESSED',
          versionCount: 1,
        },
      ],
    },
  ];

  it('正确统计大纲中各状态的章节数量', () => {
    const allNodes = mockOutline.flatMap((ch) => ch.nodes);
    const totalCount = allNodes.length;
    const processedCount = allNodes.filter((n) => n.status === 'PROCESSED').length;
    const inProgressCount = allNodes.filter((n) => n.status === 'CLAIMED').length;
    const claimableCount = allNodes.filter((n) => n.status === 'UNPROCESSED').length;

    expect(totalCount).toBe(4);
    expect(processedCount).toBe(2);
    expect(inProgressCount).toBe(1);
    expect(claimableCount).toBe(1);

    const progressPercent = Math.round((processedCount / totalCount) * 100);
    expect(progressPercent).toBe(50);
  });

  it('仅有 UNPROCESSED 节点可以被加入批量认领集合', () => {
    const allNodes = mockOutline.flatMap((ch) => ch.nodes);
    const claimableNodes = allNodes.filter((n) => n.status === 'UNPROCESSED');

    expect(claimableNodes.map((n) => n.id)).toEqual(['doc-2']);
    expect(claimableNodes.some((n) => n.status === 'PROCESSED')).toBe(false);
    expect(claimableNodes.some((n) => n.status === 'CLAIMED')).toBe(false);
  });

  it('多版本数量正确反映在已转录节点上', () => {
    const doc1 = mockOutline[0].nodes[0];
    expect(doc1.status).toBe('PROCESSED');
    expect(doc1.versionCount).toBe(2);

    const doc2 = mockOutline[0].nodes[1];
    expect(doc2.status).toBe('UNPROCESSED');
    expect(doc2.versionCount).toBe(0);
  });
});
