import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 接力工作台「大纲接力总图」API 单测：
 * 大纲就绪时的全书章/节投影、节点状态映射（含存量 TRIAL 排水）、
 * 版本数统计、无大纲兜底平铺（0 丢章）与鉴权边界。
 */

const repoFindFirstMock = vi.fn();
const docFindManyMock = vi.fn();
const versionGroupByMock = vi.fn();
const mockJobsList = vi.fn();
const getActiveOutlineMock = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: { findFirst: (...a: unknown[]) => repoFindFirstMock(...a) },
    document: { findMany: (...a: unknown[]) => docFindManyMock(...a) },
    chapterVersion: { groupBy: (...a: unknown[]) => versionGroupByMock(...a) },
  },
}));

vi.mock('@/lib/auth-utils', () => ({
  verifyRepoAccessDirect: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: vi.fn().mockResolvedValue(null),
  getAdminUserHelper: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/observability/errors', () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/engine/market-driver', () => ({
  executeSidecarMarketJobsList: (...a: unknown[]) => mockJobsList(...a),
}));

// getActiveOutline 打桩；allChaptersInTeachingOrder 等纯函数沿用真实实现（保真排序）
vi.mock('@/lib/outline-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/outline-reader')>()),
  getActiveOutline: (...a: unknown[]) => getActiveOutlineMock(...a),
}));

function makeRequest(url: string) {
  return { url, headers: new Headers(), cookies: { get: () => undefined } } as never;
}

async function callJobsApi(query: string) {
  const { GET } = await import('@/app/api/update/jobs/route');
  return GET(makeRequest(`http://localhost/api/update/jobs?${query}`), {});
}

const OUTLINE_FIXTURE = {
  outlineId: 'outline-1',
  version: 1,
  mode: 'doc',
  parts: [],
  chapters: [
    {
      id: 'ch-1',
      title: '项目概览与环境初始化',
      summary: null,
      chapterType: 'doc',
      teachingOrder: 1,
      nodes: [
        // 已烘焙正典 → PROCESSED
        { id: 'n-1', title: '1_file_import', nodeType: 'doc', headingPath: null, documentId: 'doc-a', docPath: 'docs/usage/1_file_import.md', docStatus: 'PROCESSED' },
        // 有认领人在途 → CLAIMED
        { id: 'n-2', title: '2_syntax', nodeType: 'doc', headingPath: null, documentId: 'doc-b', docPath: 'docs/usage/2_syntax.md', docStatus: 'UNPROCESSED' },
        // 无任何任务 → UNPROCESSED（未建单章节不再丢失）
        { id: 'n-3', title: '3_advanced', nodeType: 'doc', headingPath: null, documentId: 'doc-c', docPath: 'docs/usage/3_advanced.md', docStatus: 'UNPROCESSED' },
        // 编排指针存在但 Document 已失联 → 渲染跳过
        { id: 'n-4', title: '4_orphan', nodeType: 'doc', headingPath: null, documentId: 'doc-gone', docPath: null, docStatus: null },
      ],
    },
  ],
};

describe('GET /api/update/jobs（大纲接力总图）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoFindFirstMock.mockResolvedValue({
      id: 'repo-1',
      owner: 'example',
      repo: 'docs',
      isPublic: true,
      repoProfile: { siteTitle: 'Example Docs 教程', description: '社区共建转录' },
    });
    docFindManyMock.mockResolvedValue([
      { id: 'doc-a', path: 'docs/usage/1_file_import.md', title: '1_file_import', status: 'PROCESSED' },
      { id: 'doc-b', path: 'docs/usage/2_syntax.md', title: null, status: 'UNPROCESSED' },
      { id: 'doc-c', path: 'docs/usage/3_advanced.md', title: '3_advanced', status: 'UNPROCESSED' },
    ]);
    versionGroupByMock.mockResolvedValue([
      { documentId: 'doc-a', _count: { _all: 2 } },
    ]);
    mockJobsList.mockResolvedValue({
      jobs: [
        { id: 'job-claimed', documentId: 'doc-b', path: 'docs/usage/2_syntax.md', status: 'CLAIMED', kind: 'RELAY', fromSha: '', toSha: '', claimedBy: 'u-transcriber', voteDeadline: null, frozenCredits: 0 },
        { id: 'job-trial-legacy', documentId: 'doc-c', path: 'docs/usage/3_advanced.md', status: 'TRIAL', kind: 'UPDATE', fromSha: '', toSha: '', claimedBy: 'u-legacy', voteDeadline: '2099-01-01', frozenCredits: 0 },
      ],
    });
    getActiveOutlineMock.mockResolvedValue(OUTLINE_FIXTURE);
  });

  it('缺 owner/repo → 400', async () => {
    expect((await callJobsApi('owner=example')).status).toBe(400);
    expect((await callJobsApi('repo=docs')).status).toBe(400);
  });

  it('仓库不存在 → 404', async () => {
    repoFindFirstMock.mockResolvedValue(null);
    expect((await callJobsApi('owner=example&repo=docs')).status).toBe(404);
  });

  it('大纲就绪：全书章/节投影 + 节点状态映射 + 版本数 + 进度统计', async () => {
    const res = await callJobsApi('owner=example&repo=docs');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.repo).toMatchObject({
      owner: 'example',
      repo: 'docs',
      title: 'Example Docs 教程',
      description: '社区共建转录',
      totalDocs: 3,
      processedDocs: 1,
      progressPercent: 33,
    });

    const [chapter] = body.data.outline;
    expect(chapter.id).toBe('ch-1');
    expect(chapter.title).toBe('第 1 章：项目概览与环境初始化');
    expect(chapter.teachingOrder).toBe(1);

    // 验证章标题若已含「第 1 章：」前缀时绝不重复叠加（防止 "第 1 章：第 1 章：..."）
    const { formatNodeTitle } = await import('@/app/api/update/jobs/route');
    expect(formatNodeTitle('1 file import', 'docs/usage/1_file_import.md')).toBe('File Import');
    expect(formatNodeTitle('custom whisper cpp models', 'docs/custom_whisper_cpp_models.md')).toBe('Custom Whisper C++ Models');
    expect(formatNodeTitle('cli', 'docs/cli.md')).toBe('CLI');
    expect(formatNodeTitle('faq', 'docs/faq.md')).toBe('FAQ');
    expect(formatNodeTitle('index', 'docs/index.md')).toBe('Introduction');

    // docPath 缺失的编排指针被跳过（与侧边栏跳转语义一致）
    expect(chapter.nodes).toHaveLength(3);

    const [importNode, syntaxNode, advancedNode] = chapter.nodes;
    expect(importNode).toMatchObject({
      id: 'doc-a',
      documentId: 'doc-a',
      status: 'PROCESSED',
      versionCount: 2,
      claimedBy: null,
      jobId: null,
    });
    expect(syntaxNode).toMatchObject({
      status: 'CLAIMED',
      versionCount: 0,
      claimedBy: 'u-transcriber',
      jobId: 'job-claimed',
      title: 'Syntax',
    });
    // 存量 TRIAL 排水行按在途映射（claimedBy 挂载，读者可感知进度）
    expect(advancedNode).toMatchObject({
      status: 'CLAIMED',
      claimedBy: 'u-legacy',
      jobId: 'job-trial-legacy',
    });

    // 活跃任务列表兼容透传
    expect(body.data.jobs).toHaveLength(2);
  });

  it('无激活大纲（存量 V1 仓）：共享章节按路径序平铺为单章总图，0 丢章', async () => {
    getActiveOutlineMock.mockResolvedValue(null);

    const res = await callJobsApi('owner=example&repo=docs');
    const body = await res.json();

    expect(body.success).toBe(true);
    const [pseudoChapter] = body.data.outline;
    expect(pseudoChapter.id).toBe('full-outline');
    expect(pseudoChapter.nodes).toHaveLength(3);
    expect(pseudoChapter.nodes.map((n: { path: string }) => n.path)).toEqual([
      'docs/usage/1_file_import.md',
      'docs/usage/2_syntax.md',
      'docs/usage/3_advanced.md',
    ]);
  });

  it('sidecar 活跃任务列表故障不阻塞总图（jobs 空数组降级）', async () => {
    mockJobsList.mockRejectedValue(new Error('sidecar down'));

    const res = await callJobsApi('owner=example&repo=docs');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.jobs).toEqual([]);
    // 无任务挂载时全部按文档自身状态映射
    const statuses = body.data.outline[0].nodes.map((n: { status: string }) => n.status);
    expect(statuses).toEqual(['PROCESSED', 'UNPROCESSED', 'UNPROCESSED']);
  });

  it('支持传入 edition 参数精确查找指定版本的接力总图', async () => {
    await callJobsApi('owner=example&repo=docs&edition=ed_glm53');

    expect(repoFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          owner: 'example',
          repo: 'docs',
          edition: 'ed_glm53',
        }),
      })
    );
  });
});
