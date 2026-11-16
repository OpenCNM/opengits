import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 同仓导入幂等单测（P-04）：
 * 同用户对同 (owner, repo, branch, edition) 的在途任务重复提交 → 附着既有 jobId（deduped:true）；
 * 不同用户的活跃任务不互拦；无活跃任务正常建 Job。
 */

const getSessionMock = vi.fn();
const findFirstJobMock = vi.fn();
const createJobMock = vi.fn();
const scheduleMock = vi.fn();
const findFirstRepoMock = vi.fn();
const findFirstImportRecordMock = vi.fn();

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: () => getSessionMock(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        $queryRaw: vi.fn().mockResolvedValue([]),
        importJob: { create: createJobMock },
      })
    ),
    importJob: {
      findFirst: (...args: unknown[]) => findFirstJobMock(...args),
      findMany: vi.fn().mockResolvedValue([]),
      create: createJobMock,
    },
    // 积分聚合的第二数据源（章节更新任务）：无任务在途
    chapterUpdateJob: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    repository: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: (...args: unknown[]) => findFirstRepoMock(...args),
    },
    importRecord: {
      findFirst: (...args: unknown[]) => findFirstImportRecordMock(...args),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ tier: null, role: null }),
    },
  },
}));

vi.mock('@/lib/tiers', () => ({
  checkRepoLimit: vi.fn().mockResolvedValue({ allowed: true }),
  repoLimitErrorResponse: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
  clientIpFromRequest: vi.fn().mockReturnValue('203.0.113.9'),
}));

vi.mock('@/lib/observability/errors', () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/edition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/edition')>();
  return {
    ...actual,
    resolveEditionForKey: vi.fn((body: any) => actual.resolveEditionForKey(body)),
  };
});

vi.mock('@/lib/jobs/import-job-store', () => ({
  // 原子入场（B5 + TOCTOU）：直接落 Job 模拟校验通过（真实校验逻辑由 credits-ledger 侧测试覆盖）
  createImportJob: vi.fn(async (input: unknown) => ({ jobId: await createJobMock(input), deduped: false })),
  scheduleImportJob: (...args: unknown[]) => scheduleMock(...args),
}));

import { NextRequest } from 'next/server';

function postRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/ingest 同仓导入幂等', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({ user: { id: 'u1' } });
    findFirstJobMock.mockResolvedValue(null);
    createJobMock.mockResolvedValue('new-job-id');
    scheduleMock.mockResolvedValue(undefined);
    findFirstRepoMock.mockResolvedValue(null);
    findFirstImportRecordMock.mockResolvedValue(null);
  });

  async function callPost(bodyOverrides: Record<string, unknown> = {}) {
    const mod = await import('@/app/api/ingest/route');
    return mod.POST(postRequest({ owner: 'acme', repo: 'docs', ...bodyOverrides }), { params: Promise.resolve({}) });
  }

  it('同用户在途任务存在 → 返回既有 jobId + deduped:true,不建新 Job（data 信封）', async () => {
    findFirstJobMock.mockResolvedValue({ id: 'existing-job', userId: 'u1' });
    const res = await callPost();
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: { jobId: 'existing-job', deduped: true } });
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('活跃任务属于其他用户 → 不互拦,照常新建 Job', async () => {
    findFirstJobMock.mockResolvedValue({ id: 'other-user-job', userId: 'u2' });
    const res = await callPost();
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: { jobId: 'new-job-id' } });
    expect(body.data.deduped).toBeUndefined();
    expect(createJobMock).toHaveBeenCalledTimes(1);
  });

  it('无活跃任务 → 正常建 Job 并调度', async () => {
    const res = await callPost();
    expect(res.status).toBe(202);
    expect((await res.json()).data.jobId).toBe('new-job-id');
    // 幂等查询条件覆盖 owner/repo/branch/edition/status
    expect(findFirstJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          owner: 'acme',
          repo: 'docs',
          branch: 'main',
          edition: '',
          status: { in: ['QUEUED', 'RUNNING'] },
        }),
      }),
    );
    expect(scheduleMock).toHaveBeenCalledWith('new-job-id');
  });

  describe('版本不可变守卫（公开/私有既有教程严禁原地覆写，强制引导走 edition）', () => {
    it('公开教程存在且文档不为空：原作者本人尝试基础覆盖亦被拦截（409 CONFLICT），强制引导走 edition', async () => {
      findFirstRepoMock.mockResolvedValue({
        id: 'repo-pub-1',
        isPublic: true,
        documents: [{ id: 'doc-1' }],
      });
      findFirstImportRecordMock.mockResolvedValue({ userId: 'u1' });

      const res = await callPost();
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.detail).toMatch(/already exists\. Please create a new edition/);
      expect(createJobMock).not.toHaveBeenCalled();
    });

    it('公开教程存在且文档不为空：非原作者尝试覆盖同样被拦截，返回 409 CONFLICT', async () => {
      findFirstRepoMock.mockResolvedValue({
        id: 'repo-pub-1',
        isPublic: true,
        documents: [{ id: 'doc-1' }],
      });
      findFirstImportRecordMock.mockResolvedValue({ userId: 'original-author-id' });

      const res = await callPost();
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.detail).toMatch(/already exists\. Please create a new edition/);
      expect(createJobMock).not.toHaveBeenCalled();
    });

    it('私有书架教程存在且文档不为空：作者本人尝试覆盖同样被拦截（409 CONFLICT），强制引导走 edition', async () => {
      findFirstRepoMock.mockResolvedValue({
        id: 'repo-priv-1',
        isPublic: false,
        documents: [{ id: 'doc-1' }],
      });
      findFirstImportRecordMock.mockResolvedValue({ userId: 'u1' });

      const res = await callPost();
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.detail).toMatch(/already exists\. Please create a new edition/);
      expect(createJobMock).not.toHaveBeenCalled();
    });

    it('显式传入 edition: "" 尝试原地覆盖同样被拦截（409 CONFLICT）', async () => {
      findFirstRepoMock.mockResolvedValue({
        id: 'repo-pub-1',
        isPublic: true,
        documents: [{ id: 'doc-1' }],
      });

      const res = await callPost({ edition: '' });
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.detail).toMatch(/already exists\. Please create a new edition/);
      expect(createJobMock).not.toHaveBeenCalled();
    });

    it('已有 repo 但文档为空（转录中断空仓）：保留冷启动重试通道，放行创建 Job', async () => {
      findFirstRepoMock.mockResolvedValue({
        id: 'repo-pub-empty',
        isPublic: true,
        documents: [],
      });

      const res = await callPost();
      expect(res.status).toBe(202);
      expect(createJobMock).toHaveBeenCalled();
    });

    it('公开教程存在但用户选择创建新讲法（createEdition: true）→ 放行衍生版本', async () => {
      findFirstRepoMock.mockResolvedValue({
        id: 'repo-pub-1',
        isPublic: true,
        documents: [{ id: 'doc-1' }],
      });
      findFirstImportRecordMock.mockResolvedValue({ userId: 'original-author-id' });

      // createEdition=true 时 resolveEditionForKey 在 mock 中返回 ''，覆盖测试需 mock 返回衍生 key
      const { resolveEditionForKey } = await import('@/lib/edition');
      (resolveEditionForKey as any).mockReturnValueOnce('ed_derived_123');

      // 针对该衍生 key 没有既有 repo
      findFirstRepoMock.mockResolvedValueOnce(null);

      const res = await callPost({ createEdition: true });
      expect(res.status).toBe(202);
      expect(createJobMock).toHaveBeenCalled();
    });

    it('第一性原理：createEdition=true 时必须生成不可碰撞的新 edition key，物理隔离新版本', async () => {
      const res1 = await callPost({
        createEdition: true,
        editionLabel: 'deepseek-v4.1-flash 版',
      });

      expect(res1.status).toBe(202);
      const json1 = await res1.json();
      expect(json1.data.edition).toMatch(/^ed_[a-f0-9]{8}$/);
      expect(json1.data.edition).not.toBe('ed_existing_draft');
      expect(createJobMock).toHaveBeenCalledWith(
        expect.objectContaining({
          edition: json1.data.edition,
        })
      );

      // 再次以相同标签创建衍生版本，必须分配互不碰撞的新独立 edition key
      const res2 = await callPost({
        createEdition: true,
        editionLabel: 'deepseek-v4.1-flash 版',
      });
      expect(res2.status).toBe(202);
      const json2 = await res2.json();
      expect(json2.data.edition).toMatch(/^ed_[a-f0-9]{8}$/);
      expect(json2.data.edition).not.toBe(json1.data.edition);
    });

    it('createImportJob 原子入场去重（deduped: true）时必须透传 edition，保证前端路由不丢失讲法标识', async () => {
      const { createImportJob } = await import('@/lib/jobs/import-job-store');
      (createImportJob as any).mockResolvedValueOnce({
        jobId: 'deduped-tx-job-id',
        deduped: true,
      });

      const res = await callPost({
        edition: 'ed_custom_edition',
      });

      expect(res.status).toBe(202);
      const json = await res.json();
      expect(json.data).toEqual({
        jobId: 'deduped-tx-job-id',
        edition: 'ed_custom_edition',
        deduped: true,
      });
    });
  });
});
