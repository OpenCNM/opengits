import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 转录队列拓扑优先级与入队并发时序单测（transcription-queue.ts）。
 *
 * 与既有 transcription-queue.test.ts 的分工：既有文件覆盖基础纯函数公式与
 * 单次入队/回滚参数；本文件聚焦时序对抗面：
 * - 拓扑瀑布认领序（基础章严格先于下游章——喂给 PG SKIP LOCKED 的 priority 序）；
 * - PROCESSING 预写的守卫精度与失败回滚的「仅回滚自己造成的中间态」语义
 *   （防并发邻居误伤）；
 * - 并发重复入队的去重契约（镜像 Go EnqueueTranscriptionJob 的
 *   ON CONFLICT DO NOTHING + 状态存在性检查，N 并发恰 1 次 insert）。
 */

const docFindUniqueMock = vi.fn();
const docUpdateManyMock = vi.fn();
const callSidecarMock = vi.fn();

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    document: {
      findUnique: (...a: unknown[]) => docFindUniqueMock(...a),
      updateMany: (...a: unknown[]) => docUpdateManyMock(...a),
    },
  },
}));

async function freshQueue() {
  vi.resetModules();
  return import('@/lib/transcription-queue');
}

describe('拓扑瀑布认领序（computeTopologicalPriority 时序语义）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('基础章严格先于下游章：Value(engine) → Neuron(nn) → Layer(nn)，构成 SKIP LOCKED 认领瀑布', async () => {
    const { computeTopologicalPriority } = await freshQueue();
    // 统一热度噪音下，拓扑基准分（10000 - order*20）决定认领顺序
    const chapters = [
      { path: 'nn/layer.py', order: 3 },
      { path: 'engine/value.py', order: 1 },
      { path: 'nn/neuron.py', order: 2 },
    ];
    const ranked = chapters
      .map((c) => ({ path: c.path, priority: computeTopologicalPriority(c.order, 100) }))
      .sort((a, b) => b.priority - a.priority);
    expect(ranked.map((r) => r.path)).toEqual(['engine/value.py', 'nn/neuron.py', 'nn/layer.py']);
  });

  it('深层下游（order≥500）拓扑加成归零：基础章零热度仍碾压下游高序章', async () => {
    const { computeTopologicalPriority } = await freshQueue();
    expect(computeTopologicalPriority(1, 0)).toBeGreaterThan(computeTopologicalPriority(500, 0));
    expect(computeTopologicalPriority(500, 0)).toBe(0);
    // order 缺失（null）无加成：纯热度
    expect(computeTopologicalPriority(null, 42)).toBe(42);
  });

  it('显式 priority 覆盖拓扑推导（人工插队语义）', async () => {
    const { computeTopologicalPriority } = await freshQueue();
    expect(computeTopologicalPriority(1, 10_000, 7)).toBe(7);
  });

  it('resolveTeachingOrder 补全矩阵：chapterNo 兜底、title 匹配、files 优先于 title、0 序号拒绝', async () => {
    const { resolveTeachingOrder } = await freshQueue();
    // chapterNo 兜底（cluster 无 teachingOrder 但有 chapterNo）
    expect(
      resolveTeachingOrder('src/value.py', undefined, {
        codeClusters: [{ chapterNo: 9, files: ['src/value.py'] }],
      }),
    ).toBe(9);
    // title 包含文件名匹配（无 files 命中时的兜底路径）
    expect(
      resolveTeachingOrder('neuron.py', undefined, {
        codeClusters: [{ teachingOrder: 4, title: 'neuron.py module deep dive' }],
      }),
    ).toBe(4);
    // 多 cluster：files 命中的 cluster 先于仅 title 匹配的 cluster（迭代序即优先级）
    expect(
      resolveTeachingOrder('layer.py', undefined, {
        codeClusters: [
          { teachingOrder: 2, title: 'layer.py advanced' },
          { teachingOrder: 8, files: ['layer.py'] },
        ],
      }),
    ).toBe(2);
    // 路径数字 0 非法（parsed > 0 守卫）→ 无 cluster 时回退 null
    expect(resolveTeachingOrder('chapters/0-intro.md')).toBeNull();
  });
});

describe('enqueueTranscription 时序：PROCESSING 预写守卫与失败回滚防误伤', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docFindUniqueMock.mockResolvedValue({ path: 'chapters/01.mdx', repository: { views: 10 } });
    docUpdateManyMock.mockResolvedValue({ count: 1 });
    callSidecarMock.mockResolvedValue({ status: 'queued' });
  });

  it('PROCESSING 预写带 not-PROCESSED 守卫：已完工文档不得被回退成中间态', async () => {
    const { enqueueTranscription } = await freshQueue();
    await enqueueTranscription('doc-done', 'u1');
    expect(docUpdateManyMock).toHaveBeenNthCalledWith(1, {
      where: { id: 'doc-done', status: { not: 'PROCESSED' } },
      data: { status: 'PROCESSING', errorMessage: null },
    });
  });

  it('sidecar 失败回滚带 PROCESSING 守卫：仅撤销自己造成的中间态，不覆盖终态', async () => {
    const { enqueueTranscription } = await freshQueue();
    callSidecarMock.mockRejectedValueOnce(new Error('sidecar down'));
    await expect(enqueueTranscription('doc-rb', 'u1')).rejects.toThrow('sidecar down');
    expect(docUpdateManyMock).toHaveBeenNthCalledWith(2, {
      where: { id: 'doc-rb', status: 'PROCESSING' },
      data: { status: 'UNPROCESSED', errorMessage: null },
    });
  });

  it('状态化守卫对抗：失败瞬间文档已被并发邻居置 PROCESSED → 回滚不得把它打回 UNPROCESSED', async () => {
    const { enqueueTranscription } = await freshQueue();
    // 镜像 SQL where 守卫语义的状态机（Node 只下发 where 条件，物理仲裁在 DB）
    const docState = { status: 'UNPROCESSED' };
    docUpdateManyMock.mockImplementation(async ({ where, data }) => {
      if (where.id !== 'doc-race') return { count: 1 };
      let matched = false;
      if (data.status === 'PROCESSING' && where.status?.not === 'PROCESSED') {
        matched = docState.status !== 'PROCESSED';
      } else if (data.status === 'UNPROCESSED' && where.status === 'PROCESSING') {
        matched = docState.status === 'PROCESSING';
      }
      if (matched) docState.status = data.status;
      return { count: matched ? 1 : 0 };
    });
    callSidecarMock.mockImplementation(async (path: string, body: { documentId: string }) => {
      if (path !== '/v1/transcription/jobs/enqueue') return { ok: true };
      if (body.documentId === 'doc-race') {
        // 入队瞬间并发邻居（如市场换入）把文档推到 PROCESSED 终态，随后入队失败
        docState.status = 'PROCESSED';
        throw new Error('enqueue failed after neighbor settled');
      }
      return { status: 'queued' };
    });

    await expect(enqueueTranscription('doc-race', 'u1')).rejects.toThrow('enqueue failed');
    // 关键断言：回滚 where status:'PROCESSING' 未命中 → 终态 PROCESSED 得以保全
    expect(docState.status).toBe('PROCESSED');
  });
});

describe('并发重复入队去重契约（镜像 Go EnqueueTranscriptionJob 语义）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docFindUniqueMock.mockResolvedValue({ path: 'chapters/01.mdx', repository: { views: 10 } });
    docUpdateManyMock.mockResolvedValue({ count: 1 });
  });

  it('3 路并发同文档入队（TOCTOU 交错窗口）→ 恰 1 次 queued / 2 次 exists / 1 次物理插入', async () => {
    const { enqueueTranscription } = await freshQueue();
    // 状态化 mock：镜像 Go 侧入队契约（ON CONFLICT DO NOTHING + 状态存在性检查）。
    // await 窗口刻意制造 check-then-write 交错——去重仲裁完全依赖契约实现，
    // 与生产一致（真实仲裁在 Go 单事务内完成）。
    const store = new Map<string, string>();
    let inserts = 0;
    callSidecarMock.mockImplementation(async (path: string, body: { documentId: string }) => {
      if (path !== '/v1/transcription/jobs/enqueue') return { ok: true };
      await Promise.resolve();
      await Promise.resolve();
      const current = store.get(body.documentId);
      if (current === 'QUEUED' || current === 'RUNNING') return { status: 'exists' };
      if (current === 'DONE' || current === 'FAILED') {
        store.set(body.documentId, 'QUEUED');
        return { status: 'reset' };
      }
      store.set(body.documentId, 'QUEUED');
      inserts += 1;
      return { status: 'queued' };
    });

    const results = await Promise.all([
      enqueueTranscription('doc-dup', 'u1'),
      enqueueTranscription('doc-dup', 'u2'),
      enqueueTranscription('doc-dup', 'u3'),
    ]);
    expect(inserts).toBe(1);
    expect(results.filter((r) => r === 'queued')).toHaveLength(1);
    expect(results.filter((r) => r === 'exists')).toHaveLength(2);
  });

  it('DONE 重开（reset）与 QUEUED 保持（exists）在同一并发批次中各得其所', async () => {
    const { enqueueTranscription } = await freshQueue();
    const store = new Map<string, string>([
      ['doc-done', 'DONE'],
      ['doc-queued', 'QUEUED'],
    ]);
    callSidecarMock.mockImplementation(async (path: string, body: { documentId: string }) => {
      if (path !== '/v1/transcription/jobs/enqueue') return { ok: true };
      await Promise.resolve();
      const current = store.get(body.documentId);
      if (current === 'QUEUED' || current === 'RUNNING') return { status: 'exists' };
      store.set(body.documentId, 'QUEUED');
      return { status: current === 'DONE' || current === 'FAILED' ? 'reset' : 'queued' };
    });

    const [doneRes, queuedRes] = await Promise.all([
      enqueueTranscription('doc-done', 'u1'),
      enqueueTranscription('doc-queued', 'u1'),
    ]);
    expect(doneRes).toBe('reset');
    expect(queuedRes).toBe('exists');
  });
});
