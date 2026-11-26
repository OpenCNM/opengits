import { describe, expect, it } from 'vitest';
import {
  projectChapterLifecycleState,
  projectCourseLifecycleState,
  projectWizardLifecycleState,
  projectWizardCapsuleState,
} from '@/lib/state/curriculum-state-projector';
import type { ChapterDocumentInput } from '@/lib/state/curriculum-lifecycle-contract';
import { DocumentStatus } from '@/lib/constants';
import { useReadingProgressStore } from '@/lib/stores/reading-progress-store';

describe('Curriculum State Projector (Pure State Machine)', () => {
  describe('projectChapterLifecycleState', () => {
    it('Terminal Fact Invariant: 物理 PROCESSED 文档无条件投影为 READY，不受插队或残留任务干扰', () => {
      const cases: Array<[string, ChapterDocumentInput, Parameters<typeof projectChapterLifecycleState>[1]]> = [
        ['ID 插队', { id: 'doc-1', path: '01-intro.md', title: 'Introduction', status: DocumentStatus.PROCESSED }, { prioritizedId: 'doc-1' }],
        ['路径匹配插队', { id: 'doc-1', path: 'chapter-1.md', title: 'Chapter 1', status: DocumentStatus.PROCESSED }, { prioritizedId: 'chapter-1' }],
        [
          '脏任务/处理中 ID 残留',
          { id: 'doc-1', path: '01-intro.md', status: DocumentStatus.PROCESSED, transcriptionJob: { status: 'RUNNING' } },
          { currentProcessingId: 'doc-1', processingDocIds: ['doc-1'], prioritizedId: 'doc-1' },
        ],
      ];
      for (const [label, doc, opts] of cases) {
        expect(projectChapterLifecycleState(doc, opts), label).toBe('READY');
      }
    });

    it('Running: PROCESSING / transcriptionJob=RUNNING / processingIds 投影为 RUNNING 且优先级高于插队', () => {
      expect(projectChapterLifecycleState({ id: 'd2', path: '02.md', status: DocumentStatus.PROCESSING })).toBe('RUNNING');
      expect(
        projectChapterLifecycleState({ id: 'd2', path: '02.md', status: DocumentStatus.UNPROCESSED, transcriptionJob: { status: 'RUNNING' } })
      ).toBe('RUNNING');
      expect(projectChapterLifecycleState({ id: 'd3', path: '03.md', status: DocumentStatus.UNPROCESSED }, { currentProcessingId: 'd3' })).toBe('RUNNING');
      expect(projectChapterLifecycleState({ id: 'd3', path: '03.md', status: DocumentStatus.UNPROCESSED }, { processingDocIds: ['d3'] })).toBe('RUNNING');
      expect(projectChapterLifecycleState({ id: 'd4', path: '02.md', status: DocumentStatus.PROCESSING }, { prioritizedId: 'd4' })).toBe('RUNNING');
    });

    it('Prioritized: 非运行态下 ID / 路径等价 / URI 编码中文路径插队投影为 PRIORITIZED', () => {
      expect(
        projectChapterLifecycleState(
          { id: 'doc-pri', path: '05-advanced.md', status: DocumentStatus.UNPROCESSED, transcriptionJob: { status: 'QUEUED' } },
          { prioritizedId: 'doc-pri' }
        )
      ).toBe('PRIORITIZED');
      expect(
        projectChapterLifecycleState({ id: 'doc-pri-2', path: '05-advanced.md', status: DocumentStatus.UNPROCESSED }, { prioritizedId: '05-advanced' })
      ).toBe('PRIORITIZED');
      expect(
        projectChapterLifecycleState({ id: 'doc-encoded', path: '01-%E5%BC%95%E8%A8%80.md', status: DocumentStatus.UNPROCESSED }, { prioritizedId: '01-引言' })
      ).toBe('PRIORITIZED');
    });

    it('Queued: UNPROCESSED / QUEUED 任务 / 虚拟章节投影为 QUEUED，且 QUEUED 任务不受残留 processingDocIds 误判', () => {
      expect(projectChapterLifecycleState({ id: 'q1', path: '06.md', status: DocumentStatus.UNPROCESSED })).toBe('QUEUED');
      expect(
        projectChapterLifecycleState({ id: 'q2', path: '07.md', status: DocumentStatus.UNPROCESSED, transcriptionJob: { status: 'QUEUED', queuePosition: 3 } })
      ).toBe('QUEUED');
      expect(
        projectChapterLifecycleState(
          { id: 'q3', path: '08.md', status: DocumentStatus.UNPROCESSED, transcriptionJob: { status: 'QUEUED', queuePosition: 1 } },
          { processingDocIds: ['q3'] }
        )
      ).toBe('QUEUED');
      expect(projectChapterLifecycleState({ id: 'outline-chapters/01.mdx', path: 'chapters/01.mdx', status: DocumentStatus.UNPROCESSED, isVirtual: true })).toBe('QUEUED');
    });

    it('Failed: ERROR 或 FAILED 任务投影为 FAILED，不受 prioritizedId 或残留 processing 状态干扰', () => {
      expect(projectChapterLifecycleState({ id: 'e1', path: '08.md', status: DocumentStatus.ERROR, errorMessage: 'Parse failed' })).toBe('FAILED');
      expect(
        projectChapterLifecycleState({ id: 'e2', path: '09.md', status: DocumentStatus.UNPROCESSED, transcriptionJob: { status: 'FAILED' } })
      ).toBe('FAILED');
      expect(projectChapterLifecycleState({ id: 'e3', path: '10.md', status: DocumentStatus.ERROR }, { prioritizedId: 'e3' })).toBe('FAILED');
      expect(
        projectChapterLifecycleState(
          { id: 'e4', path: '11.md', status: DocumentStatus.ERROR, transcriptionJob: { status: 'RUNNING' } },
          { currentProcessingId: 'e4', processingDocIds: ['e4'], prioritizedId: 'e4' }
        )
      ).toBe('FAILED');
    });
  });

  describe('projectCourseLifecycleState', () => {
    it('课程状态按空集 -> TRANSCRIBING -> PARTIAL_READY -> IDLE 演进', () => {
      const empty = projectCourseLifecycleState([]);
      expect([empty.state, empty.total, empty.processed, empty.progressPct, empty.isCompleted]).toEqual(['IDLE', 0, 0, 0, false]);

      const docs: ChapterDocumentInput[] = [
        { id: '1', path: 'ch1.md', status: DocumentStatus.PROCESSING },
        { id: '2', path: 'ch2.md', status: DocumentStatus.UNPROCESSED },
        { id: '3', path: 'ch3.md', status: DocumentStatus.UNPROCESSED },
      ];
      const s1 = projectCourseLifecycleState(docs);
      expect([s1.state, s1.readyCount, s1.progressPct, s1.isCompleted]).toEqual(['TRANSCRIBING', 0, 0, false]);

      docs[0] = { id: '1', path: 'ch1.md', status: DocumentStatus.PROCESSED };
      docs[1] = { id: '2', path: 'ch2.md', status: DocumentStatus.PROCESSING };
      const s2 = projectCourseLifecycleState(docs);
      expect([s2.state, s2.readyCount, s2.progressPct, s2.isCompleted]).toEqual(['PARTIAL_READY', 1, 33, false]);

      docs[1] = { id: '2', path: 'ch2.md', status: DocumentStatus.PROCESSED };
      docs[2] = { id: '3', path: 'ch3.md', status: DocumentStatus.PROCESSING };
      const s3 = projectCourseLifecycleState(docs);
      expect([s3.state, s3.readyCount, s3.progressPct, s3.isCompleted]).toEqual(['PARTIAL_READY', 2, 67, false]);

      docs[2] = { id: '3', path: 'ch3.md', status: DocumentStatus.PROCESSED };
      const s4 = projectCourseLifecycleState(docs);
      expect([s4.state, s4.readyCount, s4.processed, s4.progressPct, s4.isCompleted]).toEqual(['IDLE', 3, 3, 100, true]);
    });

    it('isPaused / 全量失败 / 部分失败 / processingIds 聚合投影正确', () => {
      const pausedPartial = projectCourseLifecycleState(
        [
          { id: '1', path: 'ch1.md', status: DocumentStatus.PROCESSED },
          { id: '2', path: 'ch2.md', status: DocumentStatus.UNPROCESSED },
        ],
        true
      );
      expect([pausedPartial.state, pausedPartial.readyCount, pausedPartial.progressPct, pausedPartial.isCompleted]).toEqual(['PAUSED', 1, 50, false]);

      const pausedDone = projectCourseLifecycleState(
        [
          { id: '1', path: 'ch1.md', status: DocumentStatus.PROCESSED },
          { id: '2', path: 'ch2.md', status: DocumentStatus.PROCESSED },
        ],
        true
      );
      expect([pausedDone.state, pausedDone.progressPct, pausedDone.isCompleted]).toEqual(['IDLE', 100, true]);

      const allFailed = projectCourseLifecycleState([
        { id: '1', path: 'ch1.md', status: DocumentStatus.ERROR },
        { id: '2', path: 'ch2.md', status: DocumentStatus.ERROR },
      ]);
      expect([allFailed.state, allFailed.failedCount, allFailed.readyCount, allFailed.progressPct, allFailed.isCompleted]).toEqual(['FAILED', 2, 0, 0, false]);
      expect(
        projectCourseLifecycleState(
          [
            { id: '1', path: 'ch1.md', status: DocumentStatus.ERROR },
            { id: '2', path: 'ch2.md', status: DocumentStatus.ERROR },
          ],
          true
        ).state
      ).toBe('FAILED');

      const partialFailed = projectCourseLifecycleState([
        { id: '1', path: 'ch1.md', status: DocumentStatus.PROCESSED },
        { id: '2', path: 'ch2.md', status: DocumentStatus.ERROR },
      ]);
      expect([partialFailed.state, partialFailed.readyCount, partialFailed.failedCount, partialFailed.progressPct]).toEqual(['PARTIAL_READY', 1, 1, 50]);

      const withOpts = projectCourseLifecycleState(
        [
          { id: '1', path: 'ch1.md', status: DocumentStatus.UNPROCESSED },
          { id: '2', path: 'ch2.md', status: DocumentStatus.UNPROCESSED },
          { id: '3', path: 'ch3.md', status: DocumentStatus.PROCESSED },
        ],
        false,
        { currentProcessingId: '1', processingDocIds: ['2'] }
      );
      expect([withOpts.runningCount, withOpts.readyCount, withOpts.queuedCount, withOpts.state]).toEqual([2, 1, 0, 'PARTIAL_READY']);
    });
  });

  describe('projectWizardLifecycleState & projectWizardCapsuleState', () => {
    it('向导宏观生命周期状态映射矩阵（含 HANDOFF 吸收态）', () => {
      expect(projectWizardLifecycleState({ isOpen: false, step: 1 })).toBe('IDLE');
      expect(projectWizardLifecycleState({ isOpen: false, step: 2 })).toBe('IDLE');
      expect(projectWizardLifecycleState({ isOpen: false, step: 3 })).toBe('IDLE');
      expect(projectWizardLifecycleState({ isOpen: true, step: 1 })).toBe('DISCOVERING');
      expect(projectWizardLifecycleState({ isOpen: true, step: 2 })).toBe('CURATING');
      expect(projectWizardLifecycleState({ isOpen: true, step: 3, isSubmitting: true })).toBe('SUBMITTING');
      expect(projectWizardLifecycleState({ isOpen: true, step: 3, isSubmitting: false })).toBe('SUBMITTING');
      expect(projectWizardLifecycleState({ isOpen: true, step: 3, isSubmitting: false, submittedJobId: 'job-abc-123' })).toBe('HANDOFF');
      expect(projectWizardLifecycleState({ isOpen: true, step: 3, ingestSuccessInfo: { owner: 'test', repo: 'repo' } })).toBe('HANDOFF');
      expect(projectWizardLifecycleState({ isOpen: true, step: 3, isSubmitting: false, ingestFailed: true })).toBe('FAILED');
      expect(projectWizardLifecycleState({ isOpen: true, step: 3, submittedJobId: 'job-abc-123', ingestFailed: true })).toBe('HANDOFF');
      expect(projectWizardLifecycleState({ isOpen: true, step: 3, ingestSuccessInfo: { owner: 'test', repo: 'repo' }, ingestFailed: true })).toBe('HANDOFF');
    });

    it('Capsule 胶囊状态机投影全分支覆盖（错误/成功/加载/待确认/初始）', () => {
      const cases = [
        [{ isOpen: true, step: 3 as const, ingestFailed: true }, 'error', '构建异常', '入库构建中断'],
        [{ isOpen: true, step: 1 as const, scoutError: { status: 'error', diagnosticDescription: 'Repo not found' } }, 'error', '分析失败', '仓库架构解析失败'],
        [{ isOpen: true, step: 3 as const, ingestSuccessInfo: { owner: 'test', repo: 'llms' } }, 'success', '已就绪', '教程构建完成'],
        [{ isOpen: true, step: 3 as const, isSubmitting: true, logs: ['Log 1', 'Log 2: AST Symbol Graph'] }, 'loading', '构建中', 'AST Symbol Graph'],
        [{ isOpen: true, step: 2 as const, draftLoading: true, customOutline: [] }, 'loading', '规划中', '基于代码架构自适应规划大纲中'],
        [{ isOpen: true, step: 2 as const, draftLoading: false, customOutline: [], outlineGenError: 'HTTP 500: Internal Server Error (网络超时)' }, 'error', '网络中断', '网络连接异常'],
        [{ isOpen: true, step: 2 as const, draftLoading: false, customOutline: [], outlineGenError: '未知模型解析错误' }, 'error', '规划异常', '大纲自适应规划中断'],
        [{ isOpen: true, step: 2 as const, draftLoading: false, customOutline: [{ title: 'C1' }, { title: 'C2' }, { title: 'C3' }, { title: 'C4' }, { title: 'C5' }] }, 'action_required', '待确认', '大纲已就绪 (5 章) · 待确认编排'],
        [{ isOpen: true, step: 1 as const, loading: true }, 'loading', '分析中', '正在探测仓库事实与目录拓扑'],
        [{ isOpen: true, step: 1 as const, scoutData: { owner: 'rasbt', repo: 'llms-from-scratch' } }, 'action_required', '待操作', '代码架构已识别'],
        [{ isOpen: true, step: 1 as const }, 'action_required', '待输入', ''],
      ] as const;

      for (const [input, kind, badge, detailSubstr] of cases) {
        const res = projectWizardCapsuleState(input as Parameters<typeof projectWizardCapsuleState>[0]);
        expect(res.statusKind, badge).toBe(kind);
        expect(res.badgeLabel).toBe(badge);
        if (detailSubstr) expect(res.detailText).toContain(detailSubstr);
      }
    });
  });

  describe('ReaderActor Decoupling & Reading Progress Store', () => {
    it('多讲法进度强隔离与读写前导斜杠归一对称', () => {
      const store = useReadingProgressStore.getState();
      const baseRepoKey = 'iso-owner/iso-repo';
      const editionRepoKey = 'iso-owner/iso-repo:ed_deep';

      store.setChapterScore('chapter-01.md', 65, baseRepoKey);
      expect(store.getChapterScore('chapter-01.md', editionRepoKey)).toBe(0);

      store.setChapterScore('chapter-01.md', 90, editionRepoKey);
      expect(store.getChapterScore('chapter-01.md', editionRepoKey)).toBe(90);
      expect(store.getChapterScore('chapter-01.md', baseRepoKey)).toBe(65);

      store.setChapterScore('intro.md', 85, 'reader-owner/reader-repo');
      expect(store.getChapterScore('intro.md', 'reader-owner/reader-repo')).toBe(85);

      const symKey = 'reader-owner/slash-sym';
      store.setChapterScore('sym-a.md', 75, symKey);
      expect(store.getChapterScore('/sym-a.md', symKey)).toBe(75);
      store.setChapterScore('/sym-b.md', 80, symKey);
      expect(store.getChapterScore('sym-b.md', symKey)).toBe(80);
      store.setChapterScore('/sym-c.md', 88, `${symKey}:deep`);
      expect(store.getChapterScore('sym-c.md', `${symKey}:deep`)).toBe(88);
    });
  });
});
