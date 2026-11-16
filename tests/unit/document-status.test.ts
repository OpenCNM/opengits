import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockCallSidecar = vi.fn();
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => mockCallSidecar(...args),
}));

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: vi.fn().mockResolvedValue({ user: { id: 'user-1' } }),
}));

vi.mock('@/lib/auth-utils', () => ({
  checkDocumentAccess: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
  clientIpFromRequest: vi.fn().mockReturnValue('127.0.0.1'),
}));

function makeGetRequest(docId: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/documents/${docId}/status`, {
    method: 'GET',
  });
}

describe('GET /api/documents/[id]/status (Go sidecar offloaded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns dynamic progressInfo from transcriptionJob options when document is PROCESSING', async () => {
    const { GET } = await import('@/app/api/documents/[id]/status/route');
    mockCallSidecar.mockResolvedValueOnce({
      ok: true,
      found: true,
      status: 'PROCESSING',
      errorMessage: null,
      progress: 68,
      step: '代码章节: 正在生成课时正文 (8,420 字符)...',
      progressInfo: {
        progress: 68,
        step: '代码章节: 正在生成课时正文 (8,420 字符)...',
      },
    });

    const res = await GET(makeGetRequest('doc-1'), { params: Promise.resolve({ id: 'doc-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('PROCESSING');
    expect(body.data.progress).toBe(68);
    expect(body.data.step).toBe('代码章节: 正在生成课时正文 (8,420 字符)...');
    expect(body.data.progressInfo).toEqual({
      progress: 68,
      step: '代码章节: 正在生成课时正文 (8,420 字符)...',
    });
    expect(mockCallSidecar).toHaveBeenCalledWith(
      '/v1/documents/status',
      { documentId: 'doc-1' },
      expect.objectContaining({ label: 'doc-status /v1/documents/status' })
    );
  });

  it('falls back to default processing progress when progressInfo is absent', async () => {
    const { GET } = await import('@/app/api/documents/[id]/status/route');
    mockCallSidecar.mockResolvedValueOnce({
      ok: true,
      found: true,
      status: 'PROCESSING',
      errorMessage: null,
      progress: 50,
      step: '正在转录中…',
      progressInfo: {
        progress: 50,
        step: '正在转录中…',
      },
    });

    const res = await GET(makeGetRequest('doc-2'), { params: Promise.resolve({ id: 'doc-2' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('PROCESSING');
    expect(body.data.progress).toBe(50);
    expect(body.data.step).toBe('正在转录中…');
    expect(body.data.progressInfo).toEqual({
      progress: 50,
      step: '正在转录中…',
    });
  });

  it('returns 100% on PROCESSED status', async () => {
    const { GET } = await import('@/app/api/documents/[id]/status/route');
    mockCallSidecar.mockResolvedValueOnce({
      ok: true,
      found: true,
      status: 'PROCESSED',
      errorMessage: null,
      progress: 100,
      step: '编纂完成',
      progressInfo: null,
    });

    const res = await GET(makeGetRequest('doc-3'), { params: Promise.resolve({ id: 'doc-3' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('PROCESSED');
    expect(body.data.progress).toBe(100);
    expect(body.data.step).toBe('编纂完成');
    expect(body.data.progressInfo).toBeNull();
  });

  it('returns 100% and failed step on ERROR status', async () => {
    const { GET } = await import('@/app/api/documents/[id]/status/route');
    mockCallSidecar.mockResolvedValueOnce({
      ok: true,
      found: true,
      status: 'ERROR',
      errorMessage: 'Syntax compilation error in MDX AST',
      progress: 100,
      step: '编纂失败: Syntax compilation error in MDX AST',
      progressInfo: null,
    });

    const res = await GET(makeGetRequest('doc-4'), { params: Promise.resolve({ id: 'doc-4' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ERROR');
    expect(body.data.progress).toBe(100);
    expect(body.data.step).toBe('编纂失败: Syntax compilation error in MDX AST');
    expect(body.data.errorMessage).toBe('Syntax compilation error in MDX AST');
    expect(body.data.progressInfo).toBeNull();
  });

  it('returns queued status on UNPROCESSED status', async () => {
    const { GET } = await import('@/app/api/documents/[id]/status/route');
    mockCallSidecar.mockResolvedValueOnce({
      ok: true,
      found: true,
      status: 'UNPROCESSED',
      errorMessage: null,
      progress: 5,
      step: '排队等待编纂...',
      progressInfo: null,
    });

    const res = await GET(makeGetRequest('doc-5'), { params: Promise.resolve({ id: 'doc-5' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('UNPROCESSED');
    expect(body.data.progress).toBe(5);
    expect(body.data.step).toBe('排队等待编纂...');
    expect(body.data.progressInfo).toBeNull();
  });

  it('returns 404 when document not found', async () => {
    const { GET } = await import('@/app/api/documents/[id]/status/route');
    mockCallSidecar.mockResolvedValueOnce({
      ok: true,
      found: false,
    });

    const res = await GET(makeGetRequest('doc-ghost'), { params: Promise.resolve({ id: 'doc-ghost' }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('returns 403 when user has no access to the document', async () => {
    const { GET } = await import('@/app/api/documents/[id]/status/route');
    const { checkDocumentAccess } = await import('@/lib/auth-utils');
    vi.mocked(checkDocumentAccess).mockResolvedValueOnce(false);

    const res = await GET(makeGetRequest('doc-private'), { params: Promise.resolve({ id: 'doc-private' }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('FORBIDDEN');
  });

  it('allows anonymous access when document is accessible', async () => {
    const { GET } = await import('@/app/api/documents/[id]/status/route');
    const { getSessionHelper } = await import('@/lib/auth-helper');
    const { checkDocumentAccess } = await import('@/lib/auth-utils');
    vi.mocked(getSessionHelper).mockResolvedValueOnce(null as any);
    vi.mocked(checkDocumentAccess).mockResolvedValueOnce(true);

    mockCallSidecar.mockResolvedValueOnce({
      ok: true,
      found: true,
      status: 'PROCESSING',
      errorMessage: null,
      progress: 92,
      step: '定向重写: 正在深度思考...',
      progressInfo: {
        progress: 92,
        step: '定向重写: 正在深度思考...',
        updatedAt: '2026-10-15T07:45:00Z',
      },
    });

    const res = await GET(makeGetRequest('doc-public'), { params: Promise.resolve({ id: 'doc-public' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.progress).toBe(92);
    expect(body.data.progressInfo.updatedAt).toBe('2026-10-15T07:45:00Z');
  });
});

