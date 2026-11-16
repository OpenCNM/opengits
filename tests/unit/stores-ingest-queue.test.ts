import { describe, expect, it, beforeEach, vi } from 'vitest';
import { useIngestQueueStore, getNormalizedDocMap, normalizeDocPath, QueuedDocument } from '@/lib/stores/ingest-queue-store';
import { DocumentStatus, STORAGE_KEYS } from '@/lib/constants';
import { api } from '@/lib/api/client';

vi.mock('@/lib/api/client', () => ({
  api: {
    post: vi.fn().mockResolvedValue({ ok: true }),
    get: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

describe('useIngestQueueStore（异步转录与入库队列状态）', () => {
  const storeMap = new Map<string, string>();

  beforeEach(() => {
    storeMap.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storeMap.get(k) ?? null,
      setItem: (k: string, v: string) => storeMap.set(k, String(v)),
      removeItem: (k: string) => storeMap.delete(k),
      clear: () => storeMap.clear(),
    });
    vi.stubGlobal('window', {
      dispatchEvent: () => true,
    });
    useIngestQueueStore.setState({
      owner: '',
      repo: '',
      documents: [],
      isPaused: false,
      pauseMode: null,
      currentProcessingId: null,
      prioritizedId: null,
      orderedPaths: [],
    });
  });

  const doc1: QueuedDocument = { id: 'd1', path: 'guide/intro.md', title: 'Intro', status: DocumentStatus.UNPROCESSED, errorMessage: null };
  const doc2: QueuedDocument = { id: 'd2', path: 'guide/advanced.md', title: 'Advanced', status: DocumentStatus.UNPROCESSED, errorMessage: null };
  const docError: QueuedDocument = { id: 'd3', path: 'guide/fail.md', title: 'Fail', status: DocumentStatus.ERROR, errorMessage: 'LLM failed' };

  it('initRepo 能够初始化仓库并读取本地暂停偏好', () => {
    localStorage.setItem(STORAGE_KEYS.INGEST_PAUSED('octocat', 'hello-world'), 'true');

    useIngestQueueStore.getState().initRepo('octocat', 'hello-world');

    const state = useIngestQueueStore.getState();
    expect(state.owner).toBe('octocat');
    expect(state.repo).toBe('hello-world');
    expect(state.isPaused).toBe(true);
  });

  it('pause 能够暂停队列并重置处理中文档状态', () => {
    useIngestQueueStore.setState({
      owner: 'test',
      repo: 'test',
      documents: [{ ...doc1, status: DocumentStatus.PROCESSING }],
      currentProcessingId: 'd1',
    });

    useIngestQueueStore.getState().pause('immediate');

    const state = useIngestQueueStore.getState();
    expect(state.isPaused).toBe(true);
    expect(state.currentProcessingId).toBeNull();
    expect(state.documents[0].status).toBe(DocumentStatus.UNPROCESSED);
  });

  it('resume 能够恢复队列执行', () => {
    useIngestQueueStore.setState({
      owner: 'test',
      repo: 'test',
      isPaused: true,
    });

    useIngestQueueStore.getState().resume();

    const state = useIngestQueueStore.getState();
    expect(state.isPaused).toBe(false);
  });

  it('prioritize 能够设置优先文档并自动唤醒队列', async () => {
    vi.mocked(api.post).mockClear();
    useIngestQueueStore.setState({
      owner: 'test',
      repo: 'test',
      isPaused: true,
      documents: [doc1, doc2],
    });

    await useIngestQueueStore.getState().prioritize('d2');

    const state = useIngestQueueStore.getState();
    expect(state.prioritizedId).toBe('d2');
    expect(state.isPaused).toBe(false);
    // 优先级为服务端权威常量：客户端请求体不再携带 priority
    expect(api.post).toHaveBeenCalledWith('/api/documents/d2/prioritize', {});
  });

  it('prioritize 针对 ERROR 状态文档会自动调用 reset 并重置本地状态为 UNPROCESSED', async () => {
    vi.mocked(api.post).mockClear();
    useIngestQueueStore.setState({
      owner: 'test',
      repo: 'test',
      isPaused: false,
      documents: [doc1, docError],
    });

    await useIngestQueueStore.getState().prioritize('d3');

    const state = useIngestQueueStore.getState();
    expect(state.prioritizedId).toBe('d3');
    expect(api.post).toHaveBeenCalledWith('/api/documents/d3/reset', undefined, { onUnauthorized: 'throw' });
    expect(api.post).toHaveBeenCalledWith('/api/documents/d3/prioritize', {});
    expect(state.documents.find((d) => d.id === 'd3')?.status).toBe(DocumentStatus.UNPROCESSED);
  });

  it('sortDocumentsByNavTree 按照 orderedPaths 规则准确排序', () => {
    useIngestQueueStore.setState({
      orderedPaths: ['guide/advanced.md', 'guide/intro.md'],
    });

    const sorted = useIngestQueueStore.getState().sortDocumentsByNavTree([doc1, doc2]);
    expect(sorted.map((d) => d.id)).toEqual(['d2', 'd1']);
  });

});

describe('写端加固：prioritize 原子回滚与虚拟章节事实门禁', () => {
  const storeMap = new Map<string, string>();

  beforeEach(() => {
    vi.clearAllMocks();
    storeMap.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storeMap.get(k) ?? null,
      setItem: (k: string, v: string) => storeMap.set(k, String(v)),
      removeItem: (k: string) => storeMap.delete(k),
      clear: () => storeMap.clear(),
    });
    vi.stubGlobal('window', { dispatchEvent: () => true });
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    vi.mocked(api.get).mockResolvedValue({ documents: [] });
    useIngestQueueStore.setState({
      owner: 'test',
      repo: 'test',
      edition: '',
      documents: [],
      isPaused: false,
      pauseMode: null,
      currentProcessingId: null,
      prioritizedId: null,
      processingDocIds: [],
      orderedPaths: [],
    });
  });

  const realDoc: QueuedDocument = {
    id: 'd-real',
    path: 'guide/intro.md',
    title: 'Intro',
    status: DocumentStatus.UNPROCESSED,
    errorMessage: null,
  };
  const virtualDoc: QueuedDocument = {
    id: 'outline-chapters/01.mdx',
    path: 'chapters/01.mdx',
    title: 'Chapter 1',
    status: DocumentStatus.UNPROCESSED,
    errorMessage: null,
    isVirtual: true,
  };

  it('虚拟章节事实门禁：prioritize 拒绝大纲占位符，不产生本地标记与任何网络写请求', async () => {
    useIngestQueueStore.setState({ documents: [virtualDoc, realDoc] });

    const accepted = await useIngestQueueStore.getState().prioritize('outline-chapters/01.mdx');

    expect(accepted).toBe(false);
    expect(useIngestQueueStore.getState().prioritizedId).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('服务端拒绝（限流/任务不存在）时原子回滚本地乐观标记，杜绝幽灵 ⚡ 悬挂', async () => {
    useIngestQueueStore.setState({ documents: [realDoc], prioritizedId: null });
    vi.mocked(api.post).mockImplementation(async (url: string) => {
      if (url.includes('/prioritize')) {
        throw new Error('429 Too Many Requests');
      }
      return { ok: true };
    });

    const accepted = await useIngestQueueStore.getState().prioritize('d-real');

    expect(accepted).toBe(false);
    // 乐观写入的 prioritizedId 已被条件回滚
    expect(useIngestQueueStore.getState().prioritizedId).toBeNull();
  });

  it('服务端接受时保持乐观标记并 resolve true', async () => {
    useIngestQueueStore.setState({ documents: [realDoc], prioritizedId: null });

    const accepted = await useIngestQueueStore.getState().prioritize('d-real');

    expect(accepted).toBe(true);
    expect(useIngestQueueStore.getState().prioritizedId).toBe('d-real');
    expect(api.post).toHaveBeenCalledWith('/api/documents/d-real/prioritize', {});
  });
});

describe('getNormalizedDocMap（零物化单槽归一化索引）', () => {
  const makeDoc = (id: string, path: string): QueuedDocument => ({
    id,
    path,
    title: null,
    status: DocumentStatus.UNPROCESSED,
    errorMessage: null,
  });

  it('双键策略：扩展名变体并存时互不覆盖，精确查找各自命中', () => {
    const docs = [makeDoc('1', 'intro.md'), makeDoc('2', 'intro.mdx')];
    const map = getNormalizedDocMap(docs);

    expect(map.get('intro.md')?.id).toBe('1');
    expect(map.get('intro.mdx')?.id).toBe('2');
    // 归一化键先到先得（intro.md 先注册），不产生互相吞行
    expect(map.get('intro')?.id).toBe('1');
  });

  it('URI 编码与斜杠容错：归一化键兜底命中', () => {
    const docs = [makeDoc('3', '01-%E5%BC%95%E8%A8%80.md')];
    const map = getNormalizedDocMap(docs);

    expect(map.get(normalizeDocPath('/01-引言'))?.id).toBe('3');
  });

  it('documents 引用恒等时返回同一 Map 实例，引用变更后重建（单槽缓存语义）', () => {
    const docs = [makeDoc('1', 'a.md')];
    const again = [makeDoc('1', 'a.md')];

    expect(getNormalizedDocMap(docs)).toBe(getNormalizedDocMap(docs));
    expect(getNormalizedDocMap(docs)).not.toBe(getNormalizedDocMap(again));
  });
});

