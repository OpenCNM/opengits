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
    describe('Terminal Fact Invariant (CRITICAL)', () => {
      it('物理 PROCESSED 文档必须无条件且不可变地投影为 READY，即使存在插队 ID', () => {
        const doc: ChapterDocumentInput = {
          id: 'doc-1',
          path: '01-intro.md',
          title: 'Introduction',
          status: DocumentStatus.PROCESSED,
        };

        const state = projectChapterLifecycleState(doc, {
          prioritizedId: 'doc-1',
        });
        expect(state).toBe('READY');
      });

      it('物理 PROCESSED 文档不受 prioritizedId 路径匹配影响', () => {
        const doc: ChapterDocumentInput = {
          id: 'doc-1',
          path: 'chapter-1.md',
          title: 'Chapter 1',
          status: DocumentStatus.PROCESSED,
        };

        const state = projectChapterLifecycleState(doc, {
          prioritizedId: 'chapter-1',
        });
        expect(state).toBe('READY');
      });

      it('物理 PROCESSED 文档不受脏数据残留（如 RUNNING / QUEUED 任务或处理中 ID）干扰', () => {
        const doc: ChapterDocumentInput = {
          id: 'doc-1',
          path: '01-intro.md',
          status: DocumentStatus.PROCESSED,
          transcriptionJob: { status: 'RUNNING' },
        };

        const state = projectChapterLifecycleState(doc, {
          currentProcessingId: 'doc-1',
          processingDocIds: ['doc-1'],
          prioritizedId: 'doc-1',
        });
        expect(state).toBe('READY');
      });
    });

    describe('Running state projection', () => {
      it('doc.status 为 PROCESSING 时投影为 RUNNING', () => {
        const doc: ChapterDocumentInput = {
          id: 'doc-2',
          path: '02-arch.md',
          status: DocumentStatus.PROCESSING,
        };

        expect(projectChapterLifecycleState(doc)).toBe('RUNNING');
      });

      it('transcriptionJob.status 为 RUNNING 时投影为 RUNNING', () => {
        const doc: ChapterDocumentInput = {
          id: 'doc-2',
          path: '02-arch.md',
          status: DocumentStatus.UNPROCESSED,
          transcriptionJob: { status: 'RUNNING' },
        };

        expect(projectChapterLifecycleState(doc)).toBe('RUNNING');
      });

      it('位于 processingDocIds 或 currentProcessingId 时投影为 RUNNING', () => {
        const doc: ChapterDocumentInput = {
          id: 'doc-3',
          path: '03-guide.md',
          status: DocumentStatus.UNPROCESSED,
        };

        expect(
          projectChapterLifecycleState(doc, { currentProcessingId: 'doc-3' })
        ).toBe('RUNNING');

        expect(
          projectChapterLifecycleState(doc, { processingDocIds: ['doc-3'] })
        ).toBe('RUNNING');
      });

      it('正在运行态独占执行指示，优先级高于用户插队标记', () => {
        const doc: ChapterDocumentInput = {
          id: 'doc-running',
          path: '02-arch.md',
          status: DocumentStatus.PROCESSING,
        };

        const state = projectChapterLifecycleState(doc, {
          prioritizedId: 'doc-running',
        });
        expect(state).toBe('RUNNING');
      });
    });

    describe('Prioritized state projection', () => {
      it('未在执行中的文档被用户显式插队（ID 匹配）时投影为 PRIORITIZED', () => {
        const doc: ChapterDocumentInput = {
          id: 'doc-pri',
          path: '05-advanced.md',
          status: DocumentStatus.UNPROCESSED,
          transcriptionJob: { status: 'QUEUED' },
        };

        expect(
          projectChapterLifecycleState(doc, { prioritizedId: 'doc-pri' })
        ).toBe('PRIORITIZED');
      });

      it('未在执行中的文档被用户显式插队（路径语义等价匹配）时投影为 PRIORITIZED', () => {
        const doc: ChapterDocumentInput = {
          id: 'doc-pri-2',
          path: '05-advanced.md',
          status: DocumentStatus.UNPROCESSED,
        };

        expect(
          projectChapterLifecycleState(doc, { prioritizedId: '05-advanced' })
        ).toBe('PRIORITIZED');
      });

      it('支持 URI 编码路径与中文路径的语义等价匹配', () => {
        const doc: ChapterDocumentInput = {
          id: 'doc-encoded',
          path: '01-%E5%BC%95%E8%A8%80.md',
          status: DocumentStatus.UNPROCESSED,
        };

        expect(
          projectChapterLifecycleState(doc, { prioritizedId: '01-引言' })
        ).toBe('PRIORITIZED');
      });
    });

    describe('Queued state projection', () => {
      it('UNPROCESSED 文档且无插队时投影为 QUEUED', () => {
        const doc: ChapterDocumentInput = {
          id: 'doc-q1',
          path: '06-summary.md',
          status: DocumentStatus.UNPROCESSED,
        };

        expect(projectChapterLifecycleState(doc)).toBe('QUEUED');
      });

      it('transcriptionJob.status 为 QUEUED 且无插队时投影为 QUEUED', () => {
        const doc: ChapterDocumentInput = {
          id: 'doc-q2',
          path: '07-faq.md',
          status: DocumentStatus.UNPROCESSED,
          transcriptionJob: { status: 'QUEUED', queuePosition: 3 },
        };

        expect(projectChapterLifecycleState(doc)).toBe('QUEUED');
      });

      it('transcriptionJob 为 QUEUED 时不受残留的 processingDocIds 假象误判为 RUNNING', () => {
        const doc: ChapterDocumentInput = {
          id: 'doc-q3',
          path: '08-queue.md',
          status: DocumentStatus.UNPROCESSED,
          transcriptionJob: { status: 'QUEUED', queuePosition: 1 },
        };

        expect(
          projectChapterLifecycleState(doc, { processingDocIds: ['doc-q3'] })
        ).toBe('QUEUED');
      });

      it('虚拟章节（isVirtual 大纲占位符）按 QUEUED 参与 JIT 队列投影（写端守卫在 store 层）', () => {
        const doc: ChapterDocumentInput = {
          id: 'outline-chapters/01.mdx',
          path: 'chapters/01.mdx',
          status: DocumentStatus.UNPROCESSED,
          isVirtual: true,
        };

        expect(projectChapterLifecycleState(doc)).toBe('QUEUED');
      });
    });

    describe('Failed state projection', () => {
      it('doc.status 为 ERROR 时投影为 FAILED', () => {
        const doc: ChapterDocumentInput = {
          id: 'doc-err-1',
          path: '08-broken.md',
          status: DocumentStatus.ERROR,
          errorMessage: 'Parse failed',
        };

        expect(projectChapterLifecycleState(doc)).toBe('FAILED');
      });

      it('transcriptionJob.status 为 FAILED 时投影为 FAILED', () => {
        const doc: ChapterDocumentInput = {
          id: 'doc-err-2',
          path: '09-failed.md',
          status: DocumentStatus.UNPROCESSED,
          transcriptionJob: { status: 'FAILED' },
        };

        expect(projectChapterLifecycleState(doc)).toBe('FAILED');
      });

      it('失败文档不受先前遗留的 prioritizedId 误导，确定性维持 FAILED', () => {
        const doc: ChapterDocumentInput = {
          id: 'doc-err-3',
          path: '10-failed.md',
          status: DocumentStatus.ERROR,
        };

        expect(
          projectChapterLifecycleState(doc, { prioritizedId: 'doc-err-3' })
        ).toBe('FAILED');
      });

      it('物理 ERROR 文档不受 currentProcessingId / processingDocIds / isJobRunning 干扰，确定性维持 FAILED', () => {
        const doc: ChapterDocumentInput = {
          id: 'doc-err-4',
          path: '11-failed.md',
          status: DocumentStatus.ERROR,
          transcriptionJob: { status: 'RUNNING' },
        };

        expect(
          projectChapterLifecycleState(doc, {
            currentProcessingId: 'doc-err-4',
            processingDocIds: ['doc-err-4'],
            prioritizedId: 'doc-err-4',
          })
        ).toBe('FAILED');
      });
    });
  });

  describe('projectCourseLifecycleState', () => {
    it('空文档集合投影为 IDLE', () => {
      const proj = projectCourseLifecycleState([]);
      expect(proj.state).toBe('IDLE');
      expect(proj.total).toBe(0);
      expect(proj.processed).toBe(0);
      expect(proj.progressPct).toBe(0);
      expect(proj.isCompleted).toBe(false);
    });

    it('课程状态按生命周期从 TRANSCRIBING 正确迁移至 PARTIAL_READY 再到 IDLE', () => {
      const docs: ChapterDocumentInput[] = [
        { id: '1', path: 'ch1.md', status: DocumentStatus.PROCESSING },
        { id: '2', path: 'ch2.md', status: DocumentStatus.UNPROCESSED },
        { id: '3', path: 'ch3.md', status: DocumentStatus.UNPROCESSED },
      ];

      // 阶段 1: 全部未就绪（0 篇 PROCESSED），处于 TRANSCRIBING
      const stage1 = projectCourseLifecycleState(docs);
      expect(stage1.state).toBe('TRANSCRIBING');
      expect(stage1.readyCount).toBe(0);
      expect(stage1.progressPct).toBe(0);
      expect(stage1.isCompleted).toBe(false);

      // 阶段 2: 第 1 章转录完成，第 2 章开始转录 -> 翻转为 PARTIAL_READY (部分可读)
      docs[0] = { id: '1', path: 'ch1.md', status: DocumentStatus.PROCESSED };
      docs[1] = { id: '2', path: 'ch2.md', status: DocumentStatus.PROCESSING };
      const stage2 = projectCourseLifecycleState(docs);
      expect(stage2.state).toBe('PARTIAL_READY');
      expect(stage2.readyCount).toBe(1);
      expect(stage2.progressPct).toBe(33);
      expect(stage2.isCompleted).toBe(false);

      // 阶段 3: 第 2 章转录完成，第 3 章开始转录 -> 依然是 PARTIAL_READY
      docs[1] = { id: '2', path: 'ch2.md', status: DocumentStatus.PROCESSED };
      docs[2] = { id: '3', path: 'ch3.md', status: DocumentStatus.PROCESSING };
      const stage3 = projectCourseLifecycleState(docs);
      expect(stage3.state).toBe('PARTIAL_READY');
      expect(stage3.readyCount).toBe(2);
      expect(stage3.progressPct).toBe(67);
      expect(stage3.isCompleted).toBe(false);

      // 阶段 4: 全量章节转录完成 (3/3) -> 归位 IDLE，isCompleted 翻转为 true
      docs[2] = { id: '3', path: 'ch3.md', status: DocumentStatus.PROCESSED };
      const stage4 = projectCourseLifecycleState(docs);
      expect(stage4.state).toBe('IDLE');
      expect(stage4.readyCount).toBe(3);
      expect(stage4.processed).toBe(3);
      expect(stage4.progressPct).toBe(100);
      expect(stage4.isCompleted).toBe(true);
    });

    it('未完成状态下开启 isPaused 时投影为 PAUSED', () => {
      const docs: ChapterDocumentInput[] = [
        { id: '1', path: 'ch1.md', status: DocumentStatus.PROCESSED },
        { id: '2', path: 'ch2.md', status: DocumentStatus.UNPROCESSED },
      ];

      const proj = projectCourseLifecycleState(docs, true);
      expect(proj.state).toBe('PAUSED');
      expect(proj.readyCount).toBe(1);
      expect(proj.progressPct).toBe(50);
      expect(proj.isCompleted).toBe(false);
    });

    it('已 100% 完结的课程即使 isPaused 为 true 也维持 IDLE', () => {
      const docs: ChapterDocumentInput[] = [
        { id: '1', path: 'ch1.md', status: DocumentStatus.PROCESSED },
        { id: '2', path: 'ch2.md', status: DocumentStatus.PROCESSED },
      ];

      const proj = projectCourseLifecycleState(docs, true);
      expect(proj.state).toBe('IDLE');
      expect(proj.progressPct).toBe(100);
      expect(proj.isCompleted).toBe(true);
    });

    it('全量失败（0 ready 且全部错误）时投影为 FAILED', () => {
      const docs: ChapterDocumentInput[] = [
        { id: '1', path: 'ch1.md', status: DocumentStatus.ERROR },
        { id: '2', path: 'ch2.md', status: DocumentStatus.ERROR },
      ];

      const proj = projectCourseLifecycleState(docs);
      expect(proj.state).toBe('FAILED');
      expect(proj.failedCount).toBe(2);
      expect(proj.readyCount).toBe(0);
      expect(proj.progressPct).toBe(0);
      expect(proj.isCompleted).toBe(false);
    });

    it('部分就绪且剩余全部失败时依然是 PARTIAL_READY（读者仍可阅读已就绪章节）', () => {
      const docs: ChapterDocumentInput[] = [
        { id: '1', path: 'ch1.md', status: DocumentStatus.PROCESSED },
        { id: '2', path: 'ch2.md', status: DocumentStatus.ERROR },
      ];

      const proj = projectCourseLifecycleState(docs);
      expect(proj.state).toBe('PARTIAL_READY');
      expect(proj.readyCount).toBe(1);
      expect(proj.failedCount).toBe(1);
      expect(proj.progressPct).toBe(50);
    });

    it('全量失败时即使 isPaused 为 true 仍确定性投影为 FAILED', () => {
      const docs: ChapterDocumentInput[] = [
        { id: '1', path: 'ch1.md', status: DocumentStatus.ERROR },
        { id: '2', path: 'ch2.md', status: DocumentStatus.ERROR },
      ];

      const proj = projectCourseLifecycleState(docs, true);
      expect(proj.state).toBe('FAILED');
      expect(proj.failedCount).toBe(2);
      expect(proj.readyCount).toBe(0);
      expect(proj.isCompleted).toBe(false);
    });

    it('正确聚合 options 中 processingDocIds 和 currentProcessingId 的 runningCount', () => {
      const docs: ChapterDocumentInput[] = [
        { id: '1', path: 'ch1.md', status: DocumentStatus.UNPROCESSED },
        { id: '2', path: 'ch2.md', status: DocumentStatus.UNPROCESSED },
        { id: '3', path: 'ch3.md', status: DocumentStatus.PROCESSED },
      ];

      const proj = projectCourseLifecycleState(docs, false, {
        currentProcessingId: '1',
        processingDocIds: ['2'],
      });

      expect(proj.runningCount).toBe(2);
      expect(proj.readyCount).toBe(1);
      expect(proj.queuedCount).toBe(0);
      expect(proj.state).toBe('PARTIAL_READY');
    });
  });

  describe('projectWizardLifecycleState (WizardActor Decoupling)', () => {
    it('向导未打开时确定性投影为 IDLE', () => {
      expect(projectWizardLifecycleState({ isOpen: false, step: 1 })).toBe('IDLE');
      expect(projectWizardLifecycleState({ isOpen: false, step: 2 })).toBe('IDLE');
      expect(projectWizardLifecycleState({ isOpen: false, step: 3 })).toBe('IDLE');
    });

    it('Step 1 时投影为 DISCOVERING', () => {
      expect(projectWizardLifecycleState({ isOpen: true, step: 1 })).toBe('DISCOVERING');
    });

    it('Step 2 时投影为 CURATING', () => {
      expect(projectWizardLifecycleState({ isOpen: true, step: 2 })).toBe('CURATING');
    });

    it('Step 3 提交在途中 (isSubmitting=true 或 step=3 无 job 无失败) 投影为 SUBMITTING', () => {
      expect(
        projectWizardLifecycleState({ isOpen: true, step: 3, isSubmitting: true })
      ).toBe('SUBMITTING');

      expect(
        projectWizardLifecycleState({ isOpen: true, step: 3, isSubmitting: false })
      ).toBe('SUBMITTING');
    });

    it('Step 3 成功获取 Job ID 进入 HANDOFF (移交全局生命周期，单一物理事实驱动)', () => {
      expect(
        projectWizardLifecycleState({
          isOpen: true,
          step: 3,
          isSubmitting: false,
          submittedJobId: 'job-abc-123',
        })
      ).toBe('HANDOFF');

      expect(
        projectWizardLifecycleState({
          isOpen: true,
          step: 3,
          ingestSuccessInfo: { owner: 'test', repo: 'repo' },
        })
      ).toBe('HANDOFF');
    });

    it('Step 3 派发失败（未获得 Job ID、无成功信息）投影为 FAILED 终局', () => {
      expect(
        projectWizardLifecycleState({
          isOpen: true,
          step: 3,
          isSubmitting: false,
          ingestFailed: true,
        })
      ).toBe('FAILED');
    });

    it('HANDOFF 为吸收态：Job 已入库后跟随流断开（ingestFailed 误置）绝不降级为 FAILED', () => {
      // 物理场景：POST /api/ingest 成功返回 jobId 后 SSE 跟随流因网络抖动 reject，
      // 外层 catch 置 ingestFailed=true——但任务在服务端正常执行，Dock 正在跟踪
      expect(
        projectWizardLifecycleState({
          isOpen: true,
          step: 3,
          submittedJobId: 'job-abc-123',
          ingestFailed: true,
        })
      ).toBe('HANDOFF');

      expect(
        projectWizardLifecycleState({
          isOpen: true,
          step: 3,
          ingestSuccessInfo: { owner: 'test', repo: 'repo' },
          ingestFailed: true,
        })
      ).toBe('HANDOFF');
    });
  });

  describe('projectWizardCapsuleState (Capsule State Machine Projector)', () => {
    it('终态错误 (ingestFailed) 优先投影为 error / 构建异常', () => {
      const res = projectWizardCapsuleState({
        isOpen: true,
        step: 3,
        ingestFailed: true,
      });
      expect(res.statusKind).toBe('error');
      expect(res.badgeLabel).toBe('构建异常');
      expect(res.detailText).toContain('入库构建中断');
    });

    it('仓库探测错误 (scoutError) 投影为 error / 分析失败', () => {
      const res = projectWizardCapsuleState({
        isOpen: true,
        step: 1,
        scoutError: { status: 'error', diagnosticDescription: 'Repo not found' },
      });
      expect(res.statusKind).toBe('error');
      expect(res.badgeLabel).toBe('分析失败');
      expect(res.detailText).toContain('仓库架构解析失败');
    });

    it('终态成功 (ingestSuccessInfo) 优先投影为 success / 已就绪', () => {
      const res = projectWizardCapsuleState({
        isOpen: true,
        step: 3,
        ingestSuccessInfo: { owner: 'test', repo: 'llms' },
      });
      expect(res.statusKind).toBe('success');
      expect(res.badgeLabel).toBe('已就绪');
      expect(res.detailText).toContain('教程构建完成');
    });

    it('Step 3 构建中 (isSubmitting) 投影为 loading / 构建中，截取最新日志', () => {
      const res = projectWizardCapsuleState({
        isOpen: true,
        step: 3,
        isSubmitting: true,
        logs: ['Log 1: Cloning', 'Log 2: AST Symbol Graph generation in progress...'],
      });
      expect(res.statusKind).toBe('loading');
      expect(res.badgeLabel).toBe('构建中');
      expect(res.detailText).toContain('AST Symbol Graph');
    });

    it('Step 2 大纲生成中 (draftLoading = true) 投影为 loading / 规划中', () => {
      const res = projectWizardCapsuleState({
        isOpen: true,
        step: 2,
        draftLoading: true,
        customOutline: [],
      });
      expect(res.statusKind).toBe('loading');
      expect(res.badgeLabel).toBe('规划中');
      expect(res.detailText).toContain('基于代码架构自适应规划大纲中');
    });

    it('Step 2 大纲规划断网异常 (outlineGenError 包含网络或 500) 投影为 error / 网络中断', () => {
      const res = projectWizardCapsuleState({
        isOpen: true,
        step: 2,
        draftLoading: false,
        customOutline: [],
        outlineGenError: 'HTTP 500: Internal Server Error (网络超时)',
      });
      expect(res.statusKind).toBe('error');
      expect(res.badgeLabel).toBe('网络中断');
      expect(res.detailText).toContain('网络连接异常');
      expect(res.actionHint).toBe('点击处理');
    });

    it('Step 2 大纲规划一般异常 (outlineGenError) 投影为 error / 规划异常', () => {
      const res = projectWizardCapsuleState({
        isOpen: true,
        step: 2,
        draftLoading: false,
        customOutline: [],
        outlineGenError: '未知模型解析错误',
      });
      expect(res.statusKind).toBe('error');
      expect(res.badgeLabel).toBe('规划异常');
      expect(res.detailText).toContain('大纲自适应规划中断');
    });

    it('Step 2 大纲就绪待确认 (customOutline 有内容且 !draftLoading) 必须投影为 action_required / 待确认 (根绝转圈误导)', () => {
      const res = projectWizardCapsuleState({
        isOpen: true,
        step: 2,
        draftLoading: false,
        customOutline: [
          { title: 'Chapter 1' },
          { title: 'Chapter 2' },
          { title: 'Chapter 3' },
          { title: 'Chapter 4' },
          { title: 'Chapter 5' },
        ],
      });
      expect(res.statusKind).toBe('action_required');
      expect(res.badgeLabel).toBe('待确认');
      expect(res.detailText).toBe('大纲已就绪 (5 章) · 待确认编排');
      expect(res.actionHint).toBe('点击继续下一步');
    });

    it('Step 1 探测中 (loading = true) 投影为 loading / 分析中', () => {
      const res = projectWizardCapsuleState({
        isOpen: true,
        step: 1,
        loading: true,
      });
      expect(res.statusKind).toBe('loading');
      expect(res.badgeLabel).toBe('分析中');
      expect(res.detailText).toContain('正在探测仓库事实与目录拓扑');
    });

    it('Step 1 架构已识别待选目录 (scoutData 存在) 投影为 action_required / 待操作', () => {
      const res = projectWizardCapsuleState({
        isOpen: true,
        step: 1,
        scoutData: { owner: 'rasbt', repo: 'llms-from-scratch' },
      });
      expect(res.statusKind).toBe('action_required');
      expect(res.badgeLabel).toBe('待操作');
      expect(res.detailText).toContain('代码架构已识别');
    });

    it('Step 1 初始状态 投影为 action_required / 待输入', () => {
      const res = projectWizardCapsuleState({
        isOpen: true,
        step: 1,
      });
      expect(res.statusKind).toBe('action_required');
      expect(res.badgeLabel).toBe('待输入');
    });
  });

  describe('ReaderActor Decoupling & Reading Progress Store', () => {
    it('多讲法进度强隔离：讲法无独立记录时返回 0，绝不穿透回基础仓分数（与服务端行隔离对齐）', () => {
      const store = useReadingProgressStore.getState();
      const baseRepoKey = 'iso-owner/iso-repo';
      const editionRepoKey = 'iso-owner/iso-repo:ed_deep';
      const docPath = 'chapter-01.md';

      // 1. 设置基础仓库进度
      store.setChapterScore(docPath, 65, baseRepoKey);

      // 衍生讲法在尚未有独立记录时归零起步，不继承基础讲法分数
      expect(store.getChapterScore(docPath, editionRepoKey)).toBe(0);

      // 2. 为衍生讲法建立独立分数后，两讲法互不干扰
      store.setChapterScore(docPath, 90, editionRepoKey);
      expect(store.getChapterScore(docPath, editionRepoKey)).toBe(90);
      expect(store.getChapterScore(docPath, baseRepoKey)).toBe(65);
    });

    it('阅读分数与队列中间状态隔离：未在队列中的静态文档正常展示阅读分', () => {
      const store = useReadingProgressStore.getState();
      const repoKey = 'reader-owner/reader-repo';
      const docPath = 'intro.md';

      store.setChapterScore(docPath, 85, repoKey);
      const score = store.getChapterScore(docPath, repoKey);
      expect(score).toBe(85);
    });

    it('阅读进度读写归一对称：前导斜杠在写入与读取两侧语义等价（双向）', () => {
      const store = useReadingProgressStore.getState();
      const repoKey = 'reader-owner/slash-sym';

      // 写净键、读脏键
      store.setChapterScore('sym-a.md', 75, repoKey);
      expect(store.getChapterScore('/sym-a.md', repoKey)).toBe(75);

      // 写脏键（前导斜杠）、读净键——写入侧同口径归一后同样命中
      store.setChapterScore('/sym-b.md', 80, repoKey);
      expect(store.getChapterScore('sym-b.md', repoKey)).toBe(80);

      // 讲法键同样保持读写对称
      const editionKey = `${repoKey}:deep`;
      store.setChapterScore('/sym-c.md', 88, editionKey);
      expect(store.getChapterScore('sym-c.md', editionKey)).toBe(88);
    });
  });
});

