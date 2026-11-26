import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  projectChapterLifecycleState,
  projectCourseLifecycleState,
  projectWizardLifecycleState,
  projectWizardCloseAction,
} from '@/lib/state/curriculum-state-projector';
import type {
  ChapterDocumentInput,
  ChapterProjectionOptions,
  WizardLifecycleInput,
} from '@/lib/state/curriculum-lifecycle-contract';
import { projectDockTutorialFacts } from '@/lib/state/dock-status-projector';
import { projectPublishIntent } from '@/lib/state/publish-intent-projector';
import { normalizeDocPath, matchDocPath } from '@/lib/doc-path';
import { DocumentStatus } from '@/lib/constants';
import { useReadingProgressStore } from '@/lib/stores/reading-progress-store';
import { assertNever } from '@/lib/state/exhaustive';

/**
 * 投影族性质测试（Property-Based）：
 * 不测样例，测「不变量对任意输入成立」——样例测试结构性抓不到的角落输入由
 * 随机生成器覆盖。每条性质对应一条状态机铁律（见 lib/state/README.md §一）。
 */

const fcDocStatus = fc.constantFrom(...Object.values(DocumentStatus));
const fcJobStatus = fc.constantFrom('QUEUED', 'RUNNING', 'DONE', 'FAILED' as const);

const fcDoc: fc.Arbitrary<ChapterDocumentInput> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  path: fc
    .string({ minLength: 1, maxLength: 24 })
    .map((s) => s.replace(/^\/+/, '')),
  title: fc.option(fc.string({ maxLength: 10 }), { nil: undefined }),
  status: fcDocStatus,
  errorMessage: fc.option(fc.string({ maxLength: 10 }), { nil: undefined }),
  transcriptionJob: fc.option(
    fc.record({
      status: fcJobStatus,
      savedChunks: fc.nat(),
      totalChunks: fc.option(fc.nat(), { nil: null }),
    }),
    { nil: null }
  ),
});

/** 先生成文档数组，选项从文档集合中取值（保证 prioritizedId/processingIds 命中或随机的真实混合） */
const fcDocsAndOptions: fc.Arbitrary<{
  docs: ChapterDocumentInput[];
  options: ChapterProjectionOptions;
}> = fc
  .record({
    docs: fc.array(fcDoc, { maxLength: 12 }),
    prioritizedIdx: fc.option(fc.nat({ max: 11 }), { nil: null }),
    currentIdx: fc.option(fc.nat({ max: 11 }), { nil: null }),
    processingIdxs: fc.array(fc.nat({ max: 11 }), { maxLength: 4 }),
  })
  .map(({ docs, prioritizedIdx, currentIdx, processingIdxs }) => ({
    docs,
    options: {
      prioritizedId: prioritizedIdx !== null && docs[prioritizedIdx] ? docs[prioritizedIdx].id : `stray-${prioritizedIdx}`,
      currentProcessingId: currentIdx !== null && docs[currentIdx] ? docs[currentIdx].id : null,
      processingDocIds: processingIdxs
        .filter((i) => docs[i])
        .map((i) => docs[i].id),
    },
  }));

describe('性质 1：物理终态不可逆（Terminal Fact Invariant）', () => {
  it('∀ options：status=PROCESSED 必投影 READY，status=ERROR 必投影 FAILED', () => {
    const fcAnyOptions = fc.record({
      prioritizedId: fc.oneof(fc.string({ minLength: 1 }), fc.constant(null)),
      currentProcessingId: fc.oneof(fc.string({ minLength: 1 }), fc.constant(null)),
      processingDocIds: fc.array(fc.string({ minLength: 1 }), { maxLength: 3 }),
    });

    fc.assert(
      fc.property(fcDoc, fcAnyOptions, (doc, options) => {
        fc.pre(doc.status === DocumentStatus.PROCESSED || doc.status === DocumentStatus.ERROR);
        const projected = projectChapterLifecycleState(doc, options);
        if (doc.status === DocumentStatus.PROCESSED) {
          return projected === 'READY';
        }
        return projected === 'FAILED';
      }),
      { numRuns: 300 }
    );
  });
});

describe('性质 2：四计数器划分完整性（Partition Integrity）', () => {
  it('∀ docs：ready+running+(queued∨prioritized)+failed === total；isCompleted ⇔ ready===total>0', () => {
    fc.assert(
      fc.property(fcDocsAndOptions, ({ docs, options }) => {
        const p = projectCourseLifecycleState(docs, false, options);
        expect(p.total).toBe(docs.length);
        expect(p.readyCount + p.runningCount + p.queuedCount + p.failedCount).toBe(p.total);
        expect(p.isCompleted).toBe(docs.length > 0 && p.readyCount === docs.length);
        expect(p.progressPct).toBe(
          docs.length > 0 ? Math.round((p.readyCount / docs.length) * 100) : 0
        );
      }),
      { numRuns: 300 }
    );
  });

  it('∀ docs：计数与文档顺序无关（置换不变性）', () => {
    fc.assert(
      fc.property(fcDocsAndOptions, fc.nat({ max: 50 }), ({ docs, options }, seed) => {
        const shuffled = [...docs];
        // 确定性洗牌（线性同余，避免额外依赖）
        let s = seed + 1;
        for (let i = shuffled.length - 1; i > 0; i--) {
          s = (s * 1103515245 + 12345) % 2147483648;
          const j = s % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const a = projectCourseLifecycleState(docs, false, options);
        const b = projectCourseLifecycleState(shuffled, false, options);
        expect(b.readyCount).toBe(a.readyCount);
        expect(b.runningCount).toBe(a.runningCount);
        expect(b.queuedCount).toBe(a.queuedCount);
        expect(b.failedCount).toBe(a.failedCount);
      }),
      { numRuns: 200 }
    );
  });
});

describe('性质 3：HANDOFF 吸收态', () => {
  const fcWizardInput: fc.Arbitrary<WizardLifecycleInput> = fc.record({
    isOpen: fc.boolean(),
    step: fc.nat({ max: 4 }),
    isSubmitting: fc.boolean(),
    submittedJobId: fc.option(fc.string({ minLength: 1 }), { nil: null }),
    ingestSuccessInfo: fc.option(fc.record({}), { nil: null }),
    ingestFailed: fc.boolean(),
  });

  it('∀ input：submittedJobId 存在且向导打开 ⇒ 生命周期为 HANDOFF 且关闭动作不为 confirm-abort', () => {
    fc.assert(
      fc.property(fcWizardInput, (input) => {
        fc.pre(input.isOpen && input.submittedJobId !== null);
        expect(projectWizardLifecycleState(input)).toBe('HANDOFF');
        expect(projectWizardCloseAction({ ...input, isOutlineDirty: false })).not.toBe('confirm-abort');
        expect(projectWizardCloseAction({ ...input, isOutlineDirty: true })).not.toBe('confirm-abort');
      }),
      { numRuns: 200 }
    );
  });
});

describe('性质 4：发布意图蕴含（Implication）', () => {
  const fcIntentInput = fc.record({
    publishRequested: fc.boolean(),
    isPublic: fc.boolean(),
    reviewStatus: fc.option(fc.constantFrom('NONE', 'PENDING', 'APPROVED', 'REJECTED'), {
      nil: null,
    }),
    allProcessed: fc.boolean(),
  });

  it('READY_TO_SUBMIT ⇒ ¬isPublic ∧ publishRequested ∧ allProcessed；PUBLISHED ⇒ isPublic', () => {
    fc.assert(
      fc.property(fcIntentInput, (input) => {
        const s = projectPublishIntent(input);
        if (s === 'READY_TO_SUBMIT') {
          expect(input.isPublic).toBe(false);
          expect(input.publishRequested).toBe(true);
          expect(input.allProcessed).toBe(true);
        }
        if (s === 'PUBLISHED') {
          expect(input.isPublic).toBe(true);
        }
      }),
      { numRuns: 300 }
    );
  });
});

describe('性质 5：Dock 教程级事实投影', () => {
  it('dockStatus=PROCESSED ⇔ 存在物理文档且全部文档 PROCESSED；completedChapters 恒等于 PROCESSED 计数', () => {
    fc.assert(
      fc.property(fc.array(fcDoc, { maxLength: 10 }), (docs) => {
        const facts = projectDockTutorialFacts(docs);
        const processed = docs.filter((d) => d.status === DocumentStatus.PROCESSED).length;
        expect(facts.completedChapters).toBe(processed);
        expect(facts.totalChapters).toBe(docs.length);
        expect(facts.dockStatus === 'PROCESSED').toBe(docs.length > 0 && processed === docs.length);
      }),
      { numRuns: 200 }
    );
  });
});

describe('性质 6：路径归一半群（doc-path）', () => {
  const fcPlainPath = fc
    .string({ minLength: 1, maxLength: 20 })
    .filter((s) => !s.startsWith('/') && !/\.(md|mdx|markdown)\s*$/i.test(s));

  it('幂等：norm(norm(p)) === norm(p)；装饰不变：norm("/"+p+".md") === norm(p)；等价匹配自反', () => {
    fc.assert(
      fc.property(fcPlainPath, (p) => {
        const once = normalizeDocPath(p);
        // 空串漂移守卫：归一为空的路径按设计拒绝一切匹配（防 includes('') 恒真），
        // 装饰等价性质只对非空范式成立——由单测覆盖空范式分支
        fc.pre(once !== '');
        expect(normalizeDocPath(once)).toBe(once);
        expect(normalizeDocPath(`/${p}.md`)).toBe(once);
        expect(normalizeDocPath(`${p}.mdx`)).toBe(once);
        expect(matchDocPath(p, `/${p}.markdown`)).toBe(true);
        expect(matchDocPath(p, `${p}-other`)).toBe(false);
      }),
      { numRuns: 300 }
    );
  });
});

describe('性质 7：阅读进度单调半格（Monotonic Max-Join）', () => {
  it('∀ 分数序列：终值 === clamp(max(序列))，恒在 [0,100]', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -50, max: 150 }), { maxLength: 15 }),
        fc.string({ minLength: 1, maxLength: 10 }).map((s) => `prop-${s}`),
        (scores, repoKey) => {
          useReadingProgressStore.setState({ chapterScores: {}, overallProgress: 0 });
          const store = useReadingProgressStore.getState();
          for (const v of scores) store.setChapterScore('ch.md', v, repoKey);
          const final = store.getChapterScore('ch.md', repoKey);
          const expected =
            scores.length === 0
              ? 0
              : Math.min(100, Math.max(0, Math.round(Math.max(...scores.map((v) => Math.min(100, Math.max(0, Math.round(v))))))));
          expect(final).toBe(expected);
          expect(final).toBeGreaterThanOrEqual(0);
          expect(final).toBeLessThanOrEqual(100);
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('穷尽性守卫本体', () => {
  it('assertNever 对任意非法值抛错（携带消费点上下文）', () => {
    expect(() => assertNever('GHOST_STATE' as never, 'test')).toThrow(/GHOST_STATE.*test/);
  });
});
