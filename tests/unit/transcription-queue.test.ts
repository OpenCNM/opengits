import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 服务端转录队列（生产者侧）单测：入队幂等与拓扑优先级计算。
 * 消费循环（claim/reap/retry/defer/通知）已由 Go worker-sidecar 单写者接管
 * （2026-10 收口），相关用例随 Node 实现退役——Go 侧契约见
 * internal/transcription/{store,runner}_test.go 与 queries/transcription.sql。
 */


const queryRawMock = vi.fn();
const jobFindUniqueMock = vi.fn();
const jobUpdateMock = vi.fn();
const jobUpdateManyMock = vi.fn();
const jobCreateMock = vi.fn();
const docFindUniqueMock = vi.fn();
const docUpdateManyMock = vi.fn().mockResolvedValue({ count: 1 });
const callSidecarMock = vi.fn();

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRawMock(...(args as [TemplateStringsArray, ...unknown[]])),
    $executeRaw: vi.fn().mockResolvedValue(1),
    transcriptionJob: {
      findUnique: jobFindUniqueMock,
      update: jobUpdateMock,
      updateMany: jobUpdateManyMock,
      create: jobCreateMock,
    },
    document: {
      findUnique: docFindUniqueMock,
      updateMany: docUpdateManyMock,
    },
  },
}));

describe('transcription-queue(服务端共享转录队列)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docFindUniqueMock.mockResolvedValue({
      repository: { views: 42 },
    });
    jobUpdateMock.mockResolvedValue({});
    // RUNNING 孤儿回收默认无命中（不影响被测语义）
    jobUpdateManyMock.mockResolvedValue({ count: 0 });
    jobCreateMock.mockResolvedValue({});
    callSidecarMock.mockImplementation(async (path: string) => {
      if (path === '/v1/transcription/jobs/enqueue') {
        return { status: 'queued' };
      }
      return { ok: true };
    });
  });
  afterEach(() => {
    vi.resetModules();
  });

  async function freshQueue() {
    vi.resetModules();
    return import('@/lib/transcription-queue');
  }

  it('enqueueTranscription：新任务建行,priority 取仓库 views', async () => {
    const q = await freshQueue();
    callSidecarMock.mockResolvedValueOnce({ status: 'queued' });
    const r = await q.enqueueTranscription('doc1', 'u1');
    expect(r).toBe('queued');
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/transcription/jobs/enqueue',
      expect.objectContaining({ documentId: 'doc1', requestedBy: 'u1', priority: 42 }),
      expect.objectContaining({ label: 'transcription-enqueue' })
    );
  });

  it('enqueueTranscription：DONE 重开为 QUEUED(reset)；QUEUED 保持(exists)', async () => {
    const q = await freshQueue();
    callSidecarMock.mockResolvedValueOnce({ status: 'reset' });
    await expect(q.enqueueTranscription('doc1', 'u1')).resolves.toBe('reset');
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/transcription/jobs/enqueue',
      expect.objectContaining({ documentId: 'doc1', requestedBy: 'u1' }),
      expect.objectContaining({ label: 'transcription-enqueue' })
    );

    callSidecarMock.mockResolvedValueOnce({ status: 'exists' });
    await expect(q.enqueueTranscription('doc2', 'u1')).resolves.toBe('exists');
  }, 15000);

  it('2.11.3.1 TRANSCRIPTION_EXECUTOR=go 门禁（执行权唯一归 Go sidecar）', async () => {
    // Node worker 进程已物理退役（2026-10）：门禁锚定部署事实——compose 默认 go 执行器，
    // Node 侧无任何转录消费入口（队列模块仅存生产者）
    const fs = await import('fs');
    const path = await import('path');
    const dockerCompose = fs.readFileSync(path.resolve(process.cwd(), 'docker-compose.yml'), 'utf-8');
    expect(dockerCompose).toContain('TRANSCRIPTION_EXECUTOR: ${TRANSCRIPTION_EXECUTOR:-go}');
    expect(fs.existsSync(path.resolve(process.cwd(), 'apps/worker'))).toBe(false);
  });

  it('拓扑流转优先级计算：resolveTeachingOrder 与 computeTopologicalPriority', async () => {
    const q = await freshQueue();
    // 显式 options 优先
    expect(q.resolveTeachingOrder('chapters/05.mdx', { teachingOrder: 1 })).toBe(1);
    // docPath 嗅探数字
    expect(q.resolveTeachingOrder('chapters/02.mdx')).toBe(2);
    expect(q.resolveTeachingOrder('chapters/10-architecture.md')).toBe(10);
    // codeClusters 嗅探
    const clusters = [
      { teachingOrder: 3, title: 'Engine Module', files: ['src/engine/index.ts'] },
    ];
    expect(q.resolveTeachingOrder('src/engine/index.ts', undefined, { codeClusters: clusters })).toBe(3);
    // 无法解析返回 null
    expect(q.resolveTeachingOrder('random/file.txt')).toBeNull();

    // 拓扑优先级公式：Math.max(0, 10000 - order * 20) + views
    expect(q.computeTopologicalPriority(1, 10)).toBe(9980 + 10);
    expect(q.computeTopologicalPriority(2, 10)).toBe(9960 + 10);
    expect(q.computeTopologicalPriority(null, 10)).toBe(10);
    // 显式 priority 优先
    expect(q.computeTopologicalPriority(1, 10, 500)).toBe(500);
  });

  it('enqueueTranscription：按章节拓扑加权入队，消除依赖倒置', async () => {
    const q = await freshQueue();
    docFindUniqueMock.mockResolvedValue({
      path: 'chapters/01-core.mdx',
      repository: { views: 50 },
    });
    callSidecarMock.mockResolvedValueOnce({ status: 'queued' });
    const r = await q.enqueueTranscription('doc-chap-1', 'u1');
    expect(r).toBe('queued');
    // priority: (10000 - 1*20) + 50 = 10030
    expect(callSidecarMock).toHaveBeenCalledWith(
      '/v1/transcription/jobs/enqueue',
      expect.objectContaining({
        documentId: 'doc-chap-1',
        requestedBy: 'u1',
        priority: 10030,
      }),
      expect.objectContaining({ label: 'transcription-enqueue' })
    );
  });

  it('enqueueTranscription：sidecar 失败时回滚 Document 状态为 UNPROCESSED，防孤儿 PROCESSING', async () => {
    const q = await freshQueue();
    docFindUniqueMock.mockResolvedValue({
      path: 'chapters/01.mdx',
      repository: { views: 10 },
    });
    callSidecarMock.mockRejectedValueOnce(new Error('sidecar down'));
    await expect(q.enqueueTranscription('doc-orphan', 'u1')).rejects.toThrow('sidecar down');

    // 验证状态回滚：第1次是预写 PROCESSING，第2次是失败时回滚为 UNPROCESSED
    expect(docUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 'doc-orphan', status: 'PROCESSING' },
      data: { status: 'UNPROCESSED', errorMessage: null },
    });
  });
});

