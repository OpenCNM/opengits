import { describe, expect, it } from 'vitest';
import {
  projectDockTutorialFacts,
  dockStatusFromCourseLifecycle,
} from '@/lib/state/dock-status-projector';
import { DocumentStatus } from '@/lib/constants';

describe('Dock 教程级事实投影（projectDockTutorialFacts）', () => {
  it('全书完结 → PROCESSED，计数与活跃章归零', () => {
    const facts = projectDockTutorialFacts([
      { id: '1', path: 'a.md', status: DocumentStatus.PROCESSED, title: 'A' },
      { id: '2', path: 'b.md', status: DocumentStatus.PROCESSED, title: 'B' },
    ]);
    expect(facts.dockStatus).toBe('PROCESSED');
    expect(facts.completedChapters).toBe(2);
    expect(facts.totalChapters).toBe(2);
    expect(facts.activeDocPath).toBeNull();
    expect(facts.activeChapterTitle).toBeNull();
  });

  it('转录中 → PROCESSING，活跃章为首个运行中章节（标题缺失时回退文件名）', () => {
    const facts = projectDockTutorialFacts([
      { id: '1', path: 'done.md', status: DocumentStatus.PROCESSED },
      { id: '2', path: 'running/now.md', status: DocumentStatus.PROCESSING },
      { id: '3', path: 'queued.md', status: DocumentStatus.UNPROCESSED },
    ]);
    expect(facts.dockStatus).toBe('PROCESSING');
    expect(facts.activeDocPath).toBe('running/now.md');
    expect(facts.activeChapterTitle).toBe('now.md');
    expect(facts.completedChapters).toBe(1);
    expect(facts.totalChapters).toBe(3);
  });

  it('全部排队、无任何进展 → QUEUED（刚入库、尚未被 worker 认领）', () => {
    const facts = projectDockTutorialFacts([
      { id: '1', path: 'a.md', status: DocumentStatus.UNPROCESSED },
      { id: '2', path: 'b.md', status: DocumentStatus.UNPROCESSED },
    ]);
    expect(facts.dockStatus).toBe('QUEUED');
    // 无运行章时活跃位回落到队首排队章（直达语义保留）
    expect(facts.activeDocPath).toBe('a.md');
  });

  it('存在失败章且无任何活跃/排队工作 → ERROR（后台停滞悲观信号）', () => {
    const facts = projectDockTutorialFacts([
      { id: '1', path: 'a.md', status: DocumentStatus.ERROR },
      { id: '2', path: 'b.md', status: DocumentStatus.UNPROCESSED, transcriptionJob: null },
    ]);
    // b 处于排队 → 仍有活跃工作，不算停滞
    expect(facts.dockStatus).toBe('PROCESSING');

    const stalled = projectDockTutorialFacts([
      { id: '1', path: 'a.md', status: DocumentStatus.ERROR },
      { id: '2', path: 'b.md', status: DocumentStatus.ERROR },
    ]);
    expect(stalled.dockStatus).toBe('ERROR');
  });

  it('部分完成 + 剩余失败（无活跃工作）维持 ERROR；有排队时回归 PROCESSING', () => {
    const readyPlusFailed = projectDockTutorialFacts([
      { id: '1', path: 'a.md', status: DocumentStatus.PROCESSED },
      { id: '2', path: 'b.md', status: DocumentStatus.ERROR },
    ]);
    expect(readyPlusFailed.dockStatus).toBe('ERROR');

    const readyFailedQueued = projectDockTutorialFacts([
      { id: '1', path: 'a.md', status: DocumentStatus.PROCESSED },
      { id: '2', path: 'b.md', status: DocumentStatus.ERROR },
      { id: '3', path: 'c.md', status: DocumentStatus.UNPROCESSED },
    ]);
    expect(readyFailedQueued.dockStatus).toBe('PROCESSING');
  });

  it('空文档集 → QUEUED 兜底（0/0，对应初始化排队态，绝不可误判为 PROCESSED）', () => {
    const facts = projectDockTutorialFacts([]);
    expect(facts.totalChapters).toBe(0);
    expect(facts.dockStatus).toBe('QUEUED');
  });

  it('dockStatusFromCourseLifecycle：宏观状态映射齐全', () => {
    expect(dockStatusFromCourseLifecycle('IDLE')).toBe('PROCESSED');
    expect(dockStatusFromCourseLifecycle('FAILED')).toBe('ERROR');
    expect(dockStatusFromCourseLifecycle('TRANSCRIBING')).toBe('PROCESSING');
    expect(dockStatusFromCourseLifecycle('PARTIAL_READY')).toBe('PROCESSING');
    expect(dockStatusFromCourseLifecycle('PAUSED')).toBe('PROCESSING');
  });
});
