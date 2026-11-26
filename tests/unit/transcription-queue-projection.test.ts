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
  it('normalizeDocPath & matchDocPath 路径归一化与等价判定矩阵', () => {
    for (const [raw, expected] of [
      [null, ''],
      [undefined, ''],
      ['   ', ''],
      ['/intro', 'intro'],
      ['///docs/arch///', 'docs/arch'],
      ['/ /!.md', '!'],
      ['/dir/ .md', 'dir'],
      ['\u3000/intro\u3000', 'intro'],
      ['%20/%20intro.md', 'intro'],
      ['chapter-2.MDX', 'chapter-2'],
      ['/guide/index.markdown', 'guide/index'],
      ['script.ts', 'script.ts'],
      ['version-1.0', 'version-1.0'],
    ] as const) {
      expect(normalizeDocPath(raw), String(raw)).toBe(expected);
    }

    expect(matchDocPath('/docs/01-intro.md', 'docs/01-intro')).toBe(true);
    expect(matchDocPath('README.md', '/README.mdx')).toBe(true);
    expect(matchDocPath(' /!', '/ /!.md')).toBe(true);
    expect(matchDocPath('chapter-1.md', 'chapter-2.md')).toBe(false);
    expect(matchDocPath(null, 'chapter-1.md')).toBe(false);
    expect(matchDocPath('', '')).toBe(false);
  });

  it('sortDocsByNavOrder 拓扑次序排序与未命中回退字母序', () => {
    const docs: QueuedDocument[] = [
      { id: '3', path: '03-usage.md', title: 'Usage', status: DocumentStatus.UNPROCESSED, errorMessage: null },
      { id: '1', path: '/01-intro.md', title: 'Intro', status: DocumentStatus.UNPROCESSED, errorMessage: null },
      { id: '2', path: '02-arch.mdx', title: 'Arch', status: DocumentStatus.UNPROCESSED, errorMessage: null },
      { id: '4', path: 'extra-z.md', title: 'Extra Z', status: DocumentStatus.UNPROCESSED, errorMessage: null },
      { id: '5', path: 'extra-a.md', title: 'Extra A', status: DocumentStatus.UNPROCESSED, errorMessage: null },
    ];
    expect(sortDocsByNavOrder(docs, ['01-intro', '02-arch', '03-usage']).map((d) => d.id)).toEqual(['1', '2', '3']);
    expect(sortDocsByNavOrder(docs, ['non-existent']).map((d) => d.id)).toEqual(['1', '2', '3', '5', '4']);
    expect(sortDocsByNavOrder(docs, [])).toEqual(docs);
  });

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
    transcriptionJob: jobStatus ? { status: jobStatus, savedChunks: 1, totalChunks: 2 } : null,
  });

  it('selectTranscriptionProjection: 空队列 / 全完成 / ERROR 重试队列', () => {
    expect(
      selectTranscriptionProjection({ documents: [], orderedPaths: [], prioritizedId: null, currentProcessingId: null, processingDocIds: [] })
    ).toEqual({ total: 0, processed: 0, progressPct: 0, isCompleted: false, activeChapter: null, nextChapter: null, pendingQueue: [], isPrioritizedNext: false });

    const done = selectTranscriptionProjection({
      documents: [makeDoc('1', '01-intro.md', DocumentStatus.PROCESSED), makeDoc('2', '02-arch.md', DocumentStatus.PROCESSED)],
      orderedPaths: ['01-intro.md', '02-arch.md'],
      prioritizedId: null,
      currentProcessingId: null,
      processingDocIds: [],
    });
    expect([done.total, done.processed, done.progressPct, done.isCompleted, done.activeChapter, done.nextChapter]).toEqual([2, 2, 100, true, null, null]);

    const withErr = selectTranscriptionProjection({
      documents: [makeDoc('1', '01-intro.md', DocumentStatus.PROCESSED), makeDoc('2', '02-arch.md', DocumentStatus.ERROR), makeDoc('3', '03-usage.md', DocumentStatus.UNPROCESSED)],
      orderedPaths: ['01-intro.md', '02-arch.md', '03-usage.md'],
      prioritizedId: null,
      currentProcessingId: null,
      processingDocIds: [],
    });
    expect(withErr.nextChapter?.id).toBe('2');
    expect(withErr.pendingQueue.map((d) => d.id)).toEqual(['2', '3']);
  });

  it('selectTranscriptionProjection: 双章接力、插队抢占与已运行/已处理退化', () => {
    const docs = [
      makeDoc('1', '01-intro.md', DocumentStatus.PROCESSING),
      makeDoc('2', '02-arch.md', DocumentStatus.UNPROCESSED),
      makeDoc('3', '03-usage.md', DocumentStatus.UNPROCESSED),
      makeDoc('4', '04-api.md', DocumentStatus.UNPROCESSED),
    ];
    const orderedPaths = ['01-intro.md', '02-arch.md', '03-usage.md', '04-api.md'];

    const normal = selectTranscriptionProjection({ documents: docs, orderedPaths, prioritizedId: null, currentProcessingId: null, processingDocIds: [] });
    expect([normal.activeChapter?.id, normal.nextChapter?.id, normal.isPrioritizedNext]).toEqual(['1', '2', false]);

    const pri = selectTranscriptionProjection({ documents: docs, orderedPaths, prioritizedId: '4', currentProcessingId: null, processingDocIds: [] });
    expect([pri.activeChapter?.id, pri.nextChapter?.id, pri.isPrioritizedNext]).toEqual(['1', '4', true]);
    expect(pri.pendingQueue.map((d) => d.id)).toEqual(['4', '2', '3']);

    const pathPri = selectTranscriptionProjection({
      documents: [makeDoc('1', 'guide/01-intro.md', DocumentStatus.PROCESSING), makeDoc('2', 'guide/02-arch.md', DocumentStatus.UNPROCESSED), makeDoc('3', 'guide/03-usage.md', DocumentStatus.UNPROCESSED)],
      orderedPaths: ['guide/01-intro.md', 'guide/02-arch.md', 'guide/03-usage.md'],
      prioritizedId: 'guide/03-usage',
      currentProcessingId: null,
      processingDocIds: [],
    });
    expect(pathPri.nextChapter?.id).toBe('3');

    const alreadyActive = selectTranscriptionProjection({
      documents: [makeDoc('4', '04-api.md', DocumentStatus.PROCESSING), makeDoc('2', '02-arch.md', DocumentStatus.UNPROCESSED)],
      orderedPaths,
      prioritizedId: '4',
      currentProcessingId: null,
      processingDocIds: [],
    });
    expect([alreadyActive.nextChapter?.id, alreadyActive.isPrioritizedNext]).toEqual(['2', false]);

    const alreadyDone = selectTranscriptionProjection({
      documents: [makeDoc('1', '01-intro.md', DocumentStatus.PROCESSED), makeDoc('2', '02-arch.md', DocumentStatus.UNPROCESSED)],
      orderedPaths: ['01-intro.md', '02-arch.md'],
      prioritizedId: '1',
      currentProcessingId: null,
      processingDocIds: [],
    });
    expect([alreadyDone.nextChapter?.id, alreadyDone.isPrioritizedNext]).toEqual(['2', false]);
  });

  it('selectTranscriptionProjection: job RUNNING/QUEUED 语义与并发处理中排除', () => {
    const runningJob = selectTranscriptionProjection({
      documents: [makeDoc('1', '01-intro.md', DocumentStatus.UNPROCESSED, 'RUNNING'), makeDoc('2', '02-arch.md', DocumentStatus.UNPROCESSED)],
      orderedPaths: ['01-intro.md', '02-arch.md'],
      prioritizedId: null,
      currentProcessingId: null,
      processingDocIds: [],
    });
    expect([runningJob.activeChapter?.id, runningJob.nextChapter?.id]).toEqual(['1', '2']);

    const concurrent = selectTranscriptionProjection({
      documents: [
        makeDoc('1', '01-intro.md', DocumentStatus.PROCESSING, 'RUNNING'),
        makeDoc('2', '02-arch.md', DocumentStatus.PROCESSING, 'RUNNING'),
        makeDoc('3', '03-usage.md', DocumentStatus.UNPROCESSED, 'QUEUED'),
        makeDoc('4', '04-test.md', DocumentStatus.UNPROCESSED, 'QUEUED'),
      ],
      orderedPaths: ['01-intro.md', '02-arch.md', '03-usage.md', '04-test.md'],
      prioritizedId: null,
      currentProcessingId: '1',
      processingDocIds: ['1', '2'],
    });
    expect([concurrent.activeChapter?.id, concurrent.nextChapter?.id]).toEqual(['1', '3']);
    expect(concurrent.pendingQueue.map((d) => d.id)).toEqual(['3', '4']);
  });

  it('selectTranscriptionProjection: 引用稳定性与记忆化', () => {
    const state1 = {
      documents: [makeDoc('1', '01-intro.md', DocumentStatus.PROCESSING), makeDoc('2', '02-arch.md', DocumentStatus.UNPROCESSED)],
      orderedPaths: ['01-intro.md', '02-arch.md'],
      prioritizedId: null,
      currentProcessingId: null,
      processingDocIds: [],
    };
    const proj1 = selectTranscriptionProjection(state1);
    expect(selectTranscriptionProjection(state1)).toBe(proj1);
    expect(selectTranscriptionProjection(state1).pendingQueue).toBe(proj1.pendingQueue);

    const state2 = { ...state1, prioritizedId: '2' };
    const proj3 = selectTranscriptionProjection(state2);
    expect(proj3).not.toBe(proj1);
    expect(selectTranscriptionProjection(state2)).toBe(proj3);
  });
});
