import { describe, expect, it } from 'vitest';
import {
  normalizeDocPath,
  matchDocPath,
  sortDocsByNavOrder,
  selectTranscriptionProjection,
  QueuedDocument,
} from '@/lib/stores/ingest-queue-store';
import { DocumentStatus } from '@/lib/constants';

describe('Transcription Queue Projection & Path Normalization', () => {
  describe('normalizeDocPath', () => {
    it('处理空值与空白输入', () => {
      expect(normalizeDocPath(null)).toBe('');
      expect(normalizeDocPath(undefined)).toBe('');
      expect(normalizeDocPath('')).toBe('');
      expect(normalizeDocPath('   ')).toBe('');
    });

    it('去除首尾斜杠与多余路径分隔符', () => {
      expect(normalizeDocPath('/intro')).toBe('intro');
      expect(normalizeDocPath('///docs/arch///')).toBe('docs/arch');
    });

    it('混合首尾空白与斜杠边界归一（防前导空格后接斜杠导致装饰变形）', () => {
      expect(normalizeDocPath(' /!')).toBe('!');
      expect(normalizeDocPath('/ /!.md')).toBe('!');
      expect(normalizeDocPath('dir/ ')).toBe('dir');
      expect(normalizeDocPath('/dir/ .md')).toBe('dir');
      expect(normalizeDocPath(' / / /intro/// ')).toBe('intro');
      expect(normalizeDocPath('\u3000/intro\u3000')).toBe('intro');
      expect(normalizeDocPath('%20/%20intro.md')).toBe('intro');
    });

    it('统一剥离常见 markdown 扩展名（不区分大小写）', () => {
      expect(normalizeDocPath('chapter-1.md')).toBe('chapter-1');
      expect(normalizeDocPath('chapter-2.MDX')).toBe('chapter-2');
      expect(normalizeDocPath('/guide/index.markdown')).toBe('guide/index');
      expect(normalizeDocPath('deep/nested/file.MD')).toBe('deep/nested/file');
    });

    it('保留非 markdown 扩展名与正常字符', () => {
      expect(normalizeDocPath('script.ts')).toBe('script.ts');
      expect(normalizeDocPath('version-1.0')).toBe('version-1.0');
    });
  });

  describe('matchDocPath', () => {
    it('精准判定语义等价路径（忽略斜杠与扩展名差异）', () => {
      expect(matchDocPath('/docs/01-intro.md', 'docs/01-intro')).toBe(true);
      expect(matchDocPath('README.md', '/README.mdx')).toBe(true);
      expect(matchDocPath('/core/engine.markdown', 'core/engine.md')).toBe(true);
      expect(matchDocPath(' /!', '/ /!.md')).toBe(true);
      expect(matchDocPath('dir/ ', '/dir/ .md')).toBe(true);
    });

    it('识别非等价路径与空值', () => {
      expect(matchDocPath('chapter-1.md', 'chapter-2.md')).toBe(false);
      expect(matchDocPath(null, 'chapter-1.md')).toBe(false);
      expect(matchDocPath('chapter-1.md', undefined)).toBe(false);
      expect(matchDocPath('', '')).toBe(false);
    });
  });

  describe('sortDocsByNavOrder', () => {
    const docs: QueuedDocument[] = [
      { id: '3', path: '03-usage.md', title: 'Usage', status: DocumentStatus.UNPROCESSED, errorMessage: null },
      { id: '1', path: '/01-intro.md', title: 'Intro', status: DocumentStatus.UNPROCESSED, errorMessage: null },
      { id: '2', path: '02-arch.mdx', title: 'Arch', status: DocumentStatus.UNPROCESSED, errorMessage: null },
      { id: '4', path: 'extra-z.md', title: 'Extra Z', status: DocumentStatus.UNPROCESSED, errorMessage: null },
      { id: '5', path: 'extra-a.md', title: 'Extra A', status: DocumentStatus.UNPROCESSED, errorMessage: null },
    ];

    it('严格根据 orderedPaths 拓扑次序排序，并过滤出大纲章节', () => {
      const orderedPaths = ['01-intro', '02-arch', '03-usage'];
      const sorted = sortDocsByNavOrder(docs, orderedPaths);

      expect(sorted.map((d) => d.id)).toEqual(['1', '2', '3']);
    });

    it('当 orderedPaths 未匹配到任何大纲章节时，回退到按字母序对全量文档排序', () => {
      const orderedPaths = ['non-existent-1', 'non-existent-2'];
      const sorted = sortDocsByNavOrder(docs, orderedPaths);

      expect(sorted.map((d) => d.id)).toEqual(['1', '2', '3', '5', '4']);
    });

    it('当 orderedPaths 为空时，保持原样', () => {
      const sorted = sortDocsByNavOrder(docs, []);
      expect(sorted).toEqual(docs);
    });
  });

  describe('selectTranscriptionProjection (纯函数状态机读投影)', () => {
    const makeDoc = (
      id: string,
      path: string,
      status: DocumentStatus,
      jobStatus?: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED'
    ): QueuedDocument => ({
      id,
      path,
      title: `Title ${id}`,
      status,
      errorMessage: null,
      transcriptionJob: jobStatus
        ? {
            status: jobStatus,
            savedChunks: 1,
            totalChunks: 2,
          }
        : null,
    });

    it('空队列边界情况', () => {
      const projection = selectTranscriptionProjection({
        documents: [],
        orderedPaths: [],
        prioritizedId: null,
        currentProcessingId: null,
        processingDocIds: [],
      });

      expect(projection).toEqual({
        total: 0,
        processed: 0,
        progressPct: 0,
        isCompleted: false,
        activeChapter: null,
        nextChapter: null,
        pendingQueue: [],
        isPrioritizedNext: false,
      });
    });

    it('标准双章接力：Slot 1 正在转录，Slot 2 下一章正常排队', () => {
      const docs = [
        makeDoc('1', '01-intro.md', DocumentStatus.PROCESSING),
        makeDoc('2', '02-arch.md', DocumentStatus.UNPROCESSED),
        makeDoc('3', '03-usage.md', DocumentStatus.UNPROCESSED),
      ];

      const projection = selectTranscriptionProjection({
        documents: docs,
        orderedPaths: ['01-intro.md', '02-arch.md', '03-usage.md'],
        prioritizedId: null,
        currentProcessingId: null,
        processingDocIds: [],
      });

      expect(projection.total).toBe(3);
      expect(projection.processed).toBe(0);
      expect(projection.progressPct).toBe(0);
      expect(projection.isCompleted).toBe(false);
      expect(projection.activeChapter?.id).toBe('1');
      expect(projection.nextChapter?.id).toBe('2');
      expect(projection.isPrioritizedNext).toBe(false);
      expect(projection.pendingQueue.map((d) => d.id)).toEqual(['2', '3']);
    });

    it('用户显式插队（prioritizedId）：下一章立即抢占置顶', () => {
      const docs = [
        makeDoc('1', '01-intro.md', DocumentStatus.PROCESSING),
        makeDoc('2', '02-arch.md', DocumentStatus.UNPROCESSED),
        makeDoc('3', '03-usage.md', DocumentStatus.UNPROCESSED),
        makeDoc('4', '04-api.md', DocumentStatus.UNPROCESSED),
      ];

      // 用户在侧边栏点击了章节 4 的「优先」
      const projection = selectTranscriptionProjection({
        documents: docs,
        orderedPaths: ['01-intro.md', '02-arch.md', '03-usage.md', '04-api.md'],
        prioritizedId: '4',
        currentProcessingId: null,
        processingDocIds: [],
      });

      expect(projection.activeChapter?.id).toBe('1'); // 当前正在执行的不受打扰
      expect(projection.nextChapter?.id).toBe('4'); // 章节 4 抢占下一章接力位
      expect(projection.isPrioritizedNext).toBe(true);
      expect(projection.pendingQueue.map((d) => d.id)).toEqual(['4', '2', '3']);
    });

    it('当被插队的章节本身已进入 PROCESSING 时，nextChapter 回归自然排队', () => {
      const docs = [
        makeDoc('4', '04-api.md', DocumentStatus.PROCESSING),
        makeDoc('2', '02-arch.md', DocumentStatus.UNPROCESSED),
        makeDoc('3', '03-usage.md', DocumentStatus.UNPROCESSED),
      ];

      const projection = selectTranscriptionProjection({
        documents: docs,
        orderedPaths: ['01-intro.md', '02-arch.md', '03-usage.md', '04-api.md'],
        prioritizedId: '4', // 已是 active
        currentProcessingId: null,
        processingDocIds: [],
      });

      expect(projection.activeChapter?.id).toBe('4');
      expect(projection.nextChapter?.id).toBe('2');
      expect(projection.isPrioritizedNext).toBe(false);
      expect(projection.pendingQueue.map((d) => d.id)).toEqual(['2', '3']);
    });

    it('全仓转录完成状态', () => {
      const docs = [
        makeDoc('1', '01-intro.md', DocumentStatus.PROCESSED),
        makeDoc('2', '02-arch.md', DocumentStatus.PROCESSED),
      ];

      const projection = selectTranscriptionProjection({
        documents: docs,
        orderedPaths: ['01-intro.md', '02-arch.md'],
        prioritizedId: null,
        currentProcessingId: null,
        processingDocIds: [],
      });

      expect(projection.total).toBe(2);
      expect(projection.processed).toBe(2);
      expect(projection.progressPct).toBe(100);
      expect(projection.isCompleted).toBe(true);
      expect(projection.activeChapter).toBeNull();
      expect(projection.nextChapter).toBeNull();
      expect(projection.pendingQueue).toHaveLength(0);
    });

    it('支持 transcriptionJob.status === RUNNING 作为 activeChapter 事实源', () => {
      const docs = [
        makeDoc('1', '01-intro.md', DocumentStatus.UNPROCESSED, 'RUNNING'),
        makeDoc('2', '02-arch.md', DocumentStatus.UNPROCESSED),
      ];

      const projection = selectTranscriptionProjection({
        documents: docs,
        orderedPaths: ['01-intro.md', '02-arch.md'],
        prioritizedId: null,
        currentProcessingId: null,
        processingDocIds: [],
      });

      expect(projection.activeChapter?.id).toBe('1');
      expect(projection.nextChapter?.id).toBe('2');
    });

    it('transcriptionJob.status === QUEUED 必须视为排队等待态而非 activeChapter', () => {
      const docs = [
        makeDoc('1', '01-intro.md', DocumentStatus.PROCESSING, 'RUNNING'),
        makeDoc('2', '02-arch.md', DocumentStatus.PROCESSING, 'RUNNING'),
        makeDoc('3', '03-usage.md', DocumentStatus.UNPROCESSED, 'QUEUED'),
        makeDoc('4', '04-test.md', DocumentStatus.UNPROCESSED, 'QUEUED'),
      ];

      const projection = selectTranscriptionProjection({
        documents: docs,
        orderedPaths: ['01-intro.md', '02-arch.md', '03-usage.md', '04-test.md'],
        prioritizedId: null,
        currentProcessingId: '1',
        processingDocIds: ['1', '2'],
      });

      expect(projection.activeChapter?.id).toBe('1');
      expect(projection.nextChapter?.id).toBe('3');
      expect(projection.pendingQueue.map((d) => d.id)).toEqual(['3', '4']);
    });

    it('所有章节待转录且尚无 active 章节时，正确推导首章与插队章', () => {
      const docs = [
        makeDoc('1', '01-intro.md', DocumentStatus.UNPROCESSED),
        makeDoc('2', '02-arch.md', DocumentStatus.UNPROCESSED),
        makeDoc('3', '03-usage.md', DocumentStatus.UNPROCESSED),
      ];

      // 默认情况：首个待转录章节为 nextChapter
      const defaultProj = selectTranscriptionProjection({
        documents: docs,
        orderedPaths: ['01-intro.md', '02-arch.md', '03-usage.md'],
        prioritizedId: null,
        currentProcessingId: null,
        processingDocIds: [],
      });

      expect(defaultProj.activeChapter).toBeNull();
      expect(defaultProj.nextChapter?.id).toBe('1');
      expect(defaultProj.isPrioritizedNext).toBe(false);

      // 插队第 3 章：第 3 章跳到 nextChapter
      const priProj = selectTranscriptionProjection({
        documents: docs,
        orderedPaths: ['01-intro.md', '02-arch.md', '03-usage.md'],
        prioritizedId: '3',
        currentProcessingId: null,
        processingDocIds: [],
      });

      expect(priProj.activeChapter).toBeNull();
      expect(priProj.nextChapter?.id).toBe('3');
      expect(priProj.isPrioritizedNext).toBe(true);
      expect(priProj.pendingQueue.map((d) => d.id)).toEqual(['3', '1', '2']);
    });

    it('当 prioritizedId 指向已处理或不存在的 ID 时，安全退化为自然顺序', () => {
      const docs = [
        makeDoc('1', '01-intro.md', DocumentStatus.PROCESSED),
        makeDoc('2', '02-arch.md', DocumentStatus.UNPROCESSED),
      ];

      const proj = selectTranscriptionProjection({
        documents: docs,
        orderedPaths: ['01-intro.md', '02-arch.md'],
        prioritizedId: '1', // 已是 PROCESSED
        currentProcessingId: null,
        processingDocIds: [],
      });

      expect(proj.nextChapter?.id).toBe('2');
      expect(proj.isPrioritizedNext).toBe(false);
      expect(proj.pendingQueue.map((d) => d.id)).toEqual(['2']);
    });

    it('包含 ERROR 章节时的健壮性：未完成队列正确保留错误章节供重试', () => {
      const docs = [
        makeDoc('1', '01-intro.md', DocumentStatus.PROCESSED),
        makeDoc('2', '02-arch.md', DocumentStatus.ERROR),
        makeDoc('3', '03-usage.md', DocumentStatus.UNPROCESSED),
      ];

      const proj = selectTranscriptionProjection({
        documents: docs,
        orderedPaths: ['01-intro.md', '02-arch.md', '03-usage.md'],
        prioritizedId: null,
        currentProcessingId: null,
        processingDocIds: [],
      });

      expect(proj.total).toBe(3);
      expect(proj.processed).toBe(1);
      expect(proj.progressPct).toBe(33);
      expect(proj.isCompleted).toBe(false);
      expect(proj.nextChapter?.id).toBe('2');
      expect(proj.pendingQueue.map((d) => d.id)).toEqual(['2', '3']);
    });

    it('通过 currentProcessingId 或 processingDocIds 识别 activeChapter 回退', () => {
      const docs = [
        makeDoc('1', '01-intro.md', DocumentStatus.UNPROCESSED),
        makeDoc('2', '02-arch.md', DocumentStatus.UNPROCESSED),
      ];

      const proj = selectTranscriptionProjection({
        documents: docs,
        orderedPaths: ['01-intro.md', '02-arch.md'],
        prioritizedId: null,
        currentProcessingId: '1',
        processingDocIds: ['1'],
      });

      expect(proj.activeChapter?.id).toBe('1');
      expect(proj.nextChapter?.id).toBe('2');
    });

    it('多并发处理中场景：所有正在 PROCESSING/RUNNING 的文档均从 pendingQueue 中排除，nextChapter 绝不指向处理中文档', () => {
      const docs = [
        makeDoc('1', '01-intro.md', DocumentStatus.PROCESSING),
        makeDoc('2', '02-arch.md', DocumentStatus.PROCESSING),
        makeDoc('3', '03-usage.md', DocumentStatus.UNPROCESSED),
        makeDoc('4', '04-api.md', DocumentStatus.UNPROCESSED),
      ];

      const proj = selectTranscriptionProjection({
        documents: docs,
        orderedPaths: ['01-intro.md', '02-arch.md', '03-usage.md', '04-api.md'],
        prioritizedId: null,
        currentProcessingId: null,
        processingDocIds: ['1', '2'],
      });

      expect(proj.activeChapter?.id).toBe('1');
      // 章节 2 处于 PROCESSING，绝不能作为待转录下一章
      expect(proj.nextChapter?.id).toBe('3');
      expect(proj.isPrioritizedNext).toBe(false);
      expect(proj.pendingQueue.map((d) => d.id)).toEqual(['3', '4']);
    });

    it('支持以路径（如 path 或 cleanPath）作为 prioritizedId 进行匹配与插队', () => {
      const docs = [
        makeDoc('1', 'guide/01-intro.md', DocumentStatus.PROCESSING),
        makeDoc('2', 'guide/02-arch.md', DocumentStatus.UNPROCESSED),
        makeDoc('3', 'guide/03-usage.md', DocumentStatus.UNPROCESSED),
      ];

      // 传入路径而非 ID 进行插队
      const proj = selectTranscriptionProjection({
        documents: docs,
        orderedPaths: ['guide/01-intro.md', 'guide/02-arch.md', 'guide/03-usage.md'],
        prioritizedId: 'guide/03-usage',
        currentProcessingId: null,
        processingDocIds: [],
      });

      expect(proj.activeChapter?.id).toBe('1');
      expect(proj.nextChapter?.id).toBe('3');
      expect(proj.isPrioritizedNext).toBe(true);
      expect(proj.pendingQueue.map((d) => d.id)).toEqual(['3', '2']);
    });

    it('引用稳定性与记忆化（Referential Stability & Memoization for useSyncExternalStore）', () => {
      const docs = [
        makeDoc('1', '01-intro.md', DocumentStatus.PROCESSING),
        makeDoc('2', '02-arch.md', DocumentStatus.UNPROCESSED),
      ];
      const orderedPaths = ['01-intro.md', '02-arch.md'];

      const state1 = {
        documents: docs,
        orderedPaths,
        prioritizedId: null,
        currentProcessingId: null,
        processingDocIds: [],
      };

      const proj1 = selectTranscriptionProjection(state1);
      const proj2 = selectTranscriptionProjection(state1);

      // 输入未变更时必须返回完全恒定的对象引用（严格全等），杜绝 React 18/19 getSnapshot 循环报警
      expect(proj1).toBe(proj2);
      expect(proj1.pendingQueue).toBe(proj2.pendingQueue);

      // 仅当物理输入事实发生变更时，才生成新投影引用
      const state2 = {
        ...state1,
        prioritizedId: '2',
      };
      const proj3 = selectTranscriptionProjection(state2);
      expect(proj3).not.toBe(proj1);
      expect(proj3.nextChapter?.id).toBe('2');

      // 再次以相同输入读取，继续命中缓存
      const proj4 = selectTranscriptionProjection(state2);
      expect(proj4).toBe(proj3);
    });
  });
});
