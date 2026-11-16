import { describe, expect, it } from 'vitest';
import * as m from '@/paraglide/messages';
import {
  findRecommendedRelayNode,
  formatRelayDisplayTitle,
} from '@/components/update/workbench/relay-recommendation';
import type { RelayOutlineChapter } from '@/components/update/workbench/useUpdateWorkbench';

describe('Relay Recommendation Algorithm', () => {
  it('优先推荐补齐缺口的孤立断节 (Hole Stitcher)', () => {
    const outline: RelayOutlineChapter[] = [
      {
        id: 'ch-1',
        title: '第 1 章：系统概览',
        nodes: [
          { id: '1', title: 'Introduction', path: 'docs/1.md', status: 'PROCESSED' },
          { id: '2', title: 'Installation', path: 'docs/2.md', status: 'UNPROCESSED' }, // 断点！
          { id: '3', title: 'CLI', path: 'docs/3.md', status: 'PROCESSED' },
        ],
      },
      {
        id: 'ch-2',
        title: '第 2 章：进阶功能',
        nodes: [
          { id: '4', title: 'Live Recording', path: 'docs/4.md', status: 'UNPROCESSED' },
        ],
      },
    ];

    const rec = findRecommendedRelayNode(outline);
    expect(rec).not.toBeNull();
    expect(rec?.node.id).toBe('2');
    expect(rec?.badge).toBe(m.relay_rec_stitch_badge());
    expect(rec?.displayTitle).toContain('Installation');
    expect(rec?.displayTitle).toContain('安装与部署');
  });

  it('在无断点时，优先延续已完成小节之后的阅读前沿 (Forward Continuity)', () => {
    const outline: RelayOutlineChapter[] = [
      {
        id: 'ch-1',
        title: '第 1 章：系统概览',
        nodes: [
          { id: '1', title: 'Introduction', path: 'docs/1.md', status: 'PROCESSED' },
          { id: '2', title: 'Installation', path: 'docs/2.md', status: 'UNPROCESSED' }, // 前驱已完成
          { id: '3', title: 'CLI', path: 'docs/3.md', status: 'UNPROCESSED' },
        ],
      },
    ];

    const rec = findRecommendedRelayNode(outline);
    expect(rec).not.toBeNull();
    expect(rec?.node.id).toBe('2');
    expect(rec?.badge).toBe(m.relay_rec_continue_badge());
  });

  it('全书未开始时，保底推荐第 1 节起始章节', () => {
    const outline: RelayOutlineChapter[] = [
      {
        id: 'ch-1',
        title: '第 1 章：系统概览',
        nodes: [
          { id: '1', title: 'Introduction', path: 'docs/1.md', status: 'UNPROCESSED' },
          { id: '2', title: 'Installation', path: 'docs/2.md', status: 'UNPROCESSED' },
        ],
      },
    ];

    const rec = findRecommendedRelayNode(outline);
    expect(rec).not.toBeNull();
    expect(rec?.node.id).toBe('1');
    expect(rec?.badge).toBe(m.relay_rec_first_badge());
    expect(rec?.displayTitle).toBe('第 1 节 · Introduction (入门概览)');
  });

  it('全部完成时返回 null', () => {
    const outline: RelayOutlineChapter[] = [
      {
        id: 'ch-1',
        title: '第 1 章：系统概览',
        nodes: [
          { id: '1', title: 'Introduction', path: 'docs/1.md', status: 'PROCESSED' },
          { id: '2', title: 'Installation', path: 'docs/2.md', status: 'PROCESSED' },
        ],
      },
    ];

    const rec = findRecommendedRelayNode(outline);
    expect(rec).toBeNull();
  });

  it('传入 preferredJobOrDocId 时优先命中该章节', () => {
    const outline: RelayOutlineChapter[] = [
      {
        id: 'ch-1',
        title: '第 1 章：系统概览',
        nodes: [
          { id: '1', title: 'Introduction', path: 'docs/1.md', status: 'PROCESSED' },
          { id: '2', title: 'Installation', path: 'docs/2.md', status: 'UNPROCESSED' },
          { id: '3', title: 'CLI', path: 'docs/3.md', status: 'UNPROCESSED' },
        ],
      },
    ];

    const rec = findRecommendedRelayNode(outline, '3');
    expect(rec).not.toBeNull();
    expect(rec?.node.id).toBe('3');
    expect(rec?.badge).toBe(m.relay_rec_current_badge());
  });
});

describe('formatRelayDisplayTitle', () => {
  it('正确为常见英文添加中文对照注释', () => {
    expect(formatRelayDisplayTitle('Introduction', 'docs/intro.md', 0)).toBe(
      '第 1 节 · Introduction (入门概览)'
    );
    expect(formatRelayDisplayTitle('CLI', 'docs/cli.md', 1)).toBe('第 2 节 · CLI (命令行工具)');
    expect(formatRelayDisplayTitle('Live Recording', 'docs/live.md', 0)).toBe(
      '第 1 节 · Live Recording (实时录音)'
    );
  });

  it('中文标题保持原有文本不重复加节次', () => {
    expect(formatRelayDisplayTitle('系统全景架构', 'docs/arch.md', 0)).toBe('第 1 节 · 系统全景架构');
    expect(formatRelayDisplayTitle('第 1 节 · 系统全景架构', 'docs/arch.md', 0)).toBe(
      '第 1 节 · 系统全景架构'
    );
  });
});
