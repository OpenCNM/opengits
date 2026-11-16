import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockCallSidecar = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => mockCallSidecar(...args),
}));

const mockResolveNavTree = vi.fn();
vi.mock('@/lib/mcp/outline-projector', () => ({
  resolveEffectiveNavTree: (...args: unknown[]) => mockResolveNavTree(...args),
}));

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: vi.fn().mockResolvedValue(null),
}));

const mockResolveRepository = vi.fn();
vi.mock('@/lib/repository-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repository-resolver')>();
  return {
    ...actual,
    resolveRepository: (...args: unknown[]) => mockResolveRepository(...args),
  };
});

function makeIngestStatusRequest(owner: string, repo: string, edition?: string): NextRequest {
  const url = edition
    ? `http://localhost:3000/api/ingest-status/${owner}/${repo}?edition=${encodeURIComponent(edition)}`
    : `http://localhost:3000/api/ingest-status/${owner}/${repo}`;
  return new NextRequest(url, { method: 'GET' });
}

describe('GET /api/ingest-status/[owner]/[repo] (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRepository.mockResolvedValue(null);
    mockResolveNavTree.mockResolvedValue([
      { path: 'docs/chapter1.md', title: 'Chapter 1' },
      { path: 'docs/chapter2.md', title: 'Chapter 2' },
    ]);
  });

  it('仓库不存在时返回 404', async () => {
    mockCallSidecar.mockResolvedValue({
      ok: false,
      notFound: true,
    });

    const { GET } = await import('@/app/api/ingest-status/[owner]/[repo]/route');
    const res = await GET(makeIngestStatusRequest('test-owner', 'not-found'), {
      params: Promise.resolve({ owner: 'test-owner', repo: 'not-found' }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('REPOSITORY_NOT_FOUND');
  });

  it('无权限访问私有仓时返回 403', async () => {
    mockCallSidecar.mockResolvedValue({
      ok: false,
      forbidden: true,
    });

    const { GET } = await import('@/app/api/ingest-status/[owner]/[repo]/route');
    const res = await GET(makeIngestStatusRequest('test-owner', 'private-repo'), {
      params: Promise.resolve({ owner: 'test-owner', repo: 'private-repo' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('FORBIDDEN');
  });

  it('正常返回仓库与文档转录进度，并按 navTree 正确排序', async () => {
    mockCallSidecar.mockResolvedValue({
      ok: true,
      repository: {
        id: 'repo-100',
        owner: 'test-owner',
        repo: 'react-study',
        branch: 'main',
        edition: '',
        isPublic: true,
        transcriptionPaused: false,
        reviewStatus: 'APPROVED',
        publishedAt: '2026-03-01T00:00:00.000Z',
        transcriptionCreditsEarned: 50,
        repoProfile: {},
        navTree: [],
      },
      documents: [
        {
          id: 'doc-2',
          path: 'docs/chapter2.md',
          title: 'Fallback 2',
          status: 'PROCESSED',
          errorMessage: null,
          transcriptionJob: {
            status: 'COMPLETED',
            savedChunks: 3,
            totalChunks: 3,
          },
        },
        {
          id: 'doc-1',
          path: 'docs/chapter1.md',
          title: 'Fallback 1',
          status: 'UNPROCESSED',
          errorMessage: null,
          transcriptionJob: {
            status: 'RUNNING',
            savedChunks: 1,
            totalChunks: 5,
            claimedAt: '2026-03-01T00:01:00.000Z',
            createdAt: '2026-03-01T00:00:50.000Z',
            startedAtMs: 1772323260000,
          },
        },
      ],
      publishRequested: true,
    });

    const { GET } = await import('@/app/api/ingest-status/[owner]/[repo]/route');
    const res = await GET(makeIngestStatusRequest('test-owner', 'react-study'), {
      params: Promise.resolve({ owner: 'test-owner', repo: 'react-study' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.repositoryId).toBe('repo-100');
    expect(body.data.isPublic).toBe(true);
    expect(body.data.publishRequested).toBe(true);
    expect(body.data.documents).toHaveLength(2);

    // 验证按 navTree orderedPaths 排序（chapter1 排在 chapter2 前）
    expect(body.data.documents[0].path).toBe('docs/chapter1.md');
    expect(body.data.documents[0].title).toBe('Chapter 1');
    expect(body.data.documents[0].status).toBe('PROCESSING'); // RUNNING 投影为 PROCESSING
    expect(body.data.documents[0].transcriptionJob?.savedChunks).toBe(1);
    expect(body.data.documents[0].transcriptionJob?.claimedAt).toBe('2026-03-01T00:01:00.000Z');
    expect(body.data.documents[0].transcriptionJob?.startedAt).toBe(1772323260000);

    expect(body.data.documents[1].path).toBe('docs/chapter2.md');
    expect(body.data.documents[1].title).toBe('Chapter 2');
    expect(body.data.documents[1].status).toBe('PROCESSED');
  });

  it('大纲即作用域（Outline As Scope）：当存在有效导航树时，过滤非大纲物理文件，保持与外部一致', async () => {
    mockCallSidecar.mockResolvedValue({
      ok: true,
      repository: {
        id: 'repo-scope-test',
        owner: 'test-owner',
        repo: 'mixed-repo',
        branch: 'main',
        isPublic: true,
        transcriptionPaused: false,
        repoProfile: {},
        navTree: [],
      },
      documents: [
        { id: 'd-1', path: 'docs/chapter1.md', title: 'Chapter 1', status: 'PROCESSED' },
        { id: 'd-2', path: 'docs/chapter2.md', title: 'Chapter 2', status: 'PROCESSED' },
        { id: 'd-3', path: 'src/main.rs', title: 'Rust Source', status: 'UNPROCESSED' },
        { id: 'd-4', path: 'crates/lib.rs', title: 'Crate Lib', status: 'UNPROCESSED' },
      ],
    });

    const { GET } = await import('@/app/api/ingest-status/[owner]/[repo]/route');
    const res = await GET(makeIngestStatusRequest('test-owner', 'mixed-repo'), {
      params: Promise.resolve({ owner: 'test-owner', repo: 'mixed-repo' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // 核心断言：navTree 只有 2 课时，返回文档集必须严格为 2，物理源码文件不泄漏
    expect(body.data.documents).toHaveLength(2);
    expect(body.data.documents.map((d: any) => d.path)).toEqual([
      'docs/chapter1.md',
      'docs/chapter2.md',
    ]);
  });

  it('当传入已失效/晋升的讲法参数时，回退到有效 edition 传递给 sidecar 而非原始失效参数', async () => {
    mockResolveRepository.mockResolvedValue({
      repository: { id: 'repo-promoted', edition: '' },
      resolvedBranch: 'main',
      resolvedEdition: '',
      isFallback: true,
    });

    mockCallSidecar.mockResolvedValue({
      ok: true,
      repository: {
        id: 'repo-promoted',
        owner: 'test-owner',
        repo: 'promoted-repo',
        branch: 'main',
        edition: '',
        isPublic: true,
        transcriptionPaused: false,
        repoProfile: {},
        navTree: [],
      },
      documents: [],
    });

    const { GET } = await import('@/app/api/ingest-status/[owner]/[repo]/route');
    const res = await GET(makeIngestStatusRequest('test-owner', 'promoted-repo', 'ed_stale123'), {
      params: Promise.resolve({ owner: 'test-owner', repo: 'promoted-repo' }),
    });

    expect(res.status).toBe(200);
    expect(mockCallSidecar).toHaveBeenCalledWith(
      '/v1/repos/ingest-status',
      expect.objectContaining({
        owner: 'test-owner',
        repo: 'promoted-repo',
        edition: '',
      }),
      expect.any(Object)
    );
  });
});


