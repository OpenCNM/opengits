import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { PromoteEditionInputSchema } from '@/lib/schemas/credit-grant';

const repoFindUniqueMock = vi.hoisted(() => vi.fn());
const repoFindFirstMock = vi.hoisted(() => vi.fn());
const userFindUniqueMock = vi.hoisted(() => vi.fn());
const importRecordFindFirstMock = vi.hoisted(() => vi.fn());
const documentFindFirstMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const savedRepoFindFirstMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const callSidecarMock = vi.hoisted(() => vi.fn());
const revalidateTagMock = vi.hoisted(() => vi.fn());
const revalidatePathMock = vi.hoisted(() => vi.fn());
const invalidateWebL1ProjectionMock = vi.hoisted(() => vi.fn());
const getSessionHelperMock = vi.hoisted(() => vi.fn());
const getAdminUserHelperMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findUnique: repoFindUniqueMock,
      findFirst: repoFindFirstMock,
    },
    user: {
      findUnique: userFindUniqueMock,
    },
    importRecord: {
      findFirst: importRecordFindFirstMock,
    },
    document: {
      findFirst: documentFindFirstMock,
    },
    savedRepo: {
      findFirst: savedRepoFindFirstMock,
    },
  },
}));

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: callSidecarMock,
}));

vi.mock('next/cache', () => ({
  revalidateTag: revalidateTagMock,
  revalidatePath: revalidatePathMock,
}));

vi.mock('@/lib/docs/web-outline-projection', () => ({
  invalidateWebL1Projection: invalidateWebL1ProjectionMock,
}));

vi.mock('@/lib/auth-helper', () => ({
  getSessionHelper: getSessionHelperMock,
  getAdminUserHelper: getAdminUserHelperMock,
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
  clientIpFromRequest: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/observability/errors', () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

describe('Edition Promotion to Default Test Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'maintainer-1', email: 'maintainer@example.com' },
    });
    getAdminUserHelperMock.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
    });
  });

  describe('1. Zod Schema Validation', () => {
    it('PromoteEditionInputSchema 验证：支持 repoId 或 (owner + repo + edition)', () => {
      const validById = PromoteEditionInputSchema.safeParse({ repoId: 'repo-123' });
      expect(validById.success).toBe(true);

      const validByOwnerRepoEdition = PromoteEditionInputSchema.safeParse({
        owner: 'facebook',
        repo: 'react',
        edition: 'deep-dive',
      });
      expect(validByOwnerRepoEdition.success).toBe(true);

      const invalidEmpty = PromoteEditionInputSchema.safeParse({});
      expect(invalidEmpty.success).toBe(false);

      const invalidNoEdition = PromoteEditionInputSchema.safeParse({
        owner: 'facebook',
        repo: 'react',
      });
      expect(invalidNoEdition.success).toBe(false);
    });
  });

  describe('2. POST /api/repos/promote-edition 路由与授权门禁', () => {
    it('未登录时返回 401 UNAUTHORIZED', async () => {
      getSessionHelperMock.mockResolvedValueOnce(null);

      const { POST } = await import('@/app/api/repos/promote-edition/route');
      const req = new NextRequest('http://localhost/api/repos/promote-edition', {
        method: 'POST',
        body: JSON.stringify({ repoId: 'custom-repo-1' }),
      });

      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(401);
    });

    it('仓库不存在时返回 404 NOT_FOUND', async () => {
      repoFindUniqueMock.mockResolvedValueOnce(null);

      const { POST } = await import('@/app/api/repos/promote-edition/route');
      const req = new NextRequest('http://localhost/api/repos/promote-edition', {
        method: 'POST',
        body: JSON.stringify({ repoId: 'non-existent' }),
      });

      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(404);
    });

    it('目标已是主版本时返回 400 BAD_REQUEST', async () => {
      repoFindUniqueMock.mockResolvedValueOnce({
        id: 'default-repo-1',
        owner: 'org',
        repo: 'project',
        edition: '',
        isPublic: true,
        reviewPipeline: null,
      });

      const { POST } = await import('@/app/api/repos/promote-edition/route');
      const req = new NextRequest('http://localhost/api/repos/promote-edition', {
        method: 'POST',
        body: JSON.stringify({ repoId: 'default-repo-1' }),
      });

      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('已是默认主版本');
    });

    it('非维护者/属主/管理员调用返回 403 FORBIDDEN', async () => {
      repoFindUniqueMock.mockResolvedValueOnce({
        id: 'custom-repo-1',
        owner: 'org',
        repo: 'project',
        edition: 'custom-ed',
        isPublic: false,
        reviewPipeline: { publishedBy: 'other-user' },
      });
      importRecordFindFirstMock.mockResolvedValueOnce({ userId: 'another-user' });
      userFindUniqueMock.mockResolvedValueOnce({ role: 'USER', tier: 'FREE' });

      const { POST } = await import('@/app/api/repos/promote-edition/route');
      const req = new NextRequest('http://localhost/api/repos/promote-edition', {
        method: 'POST',
        body: JSON.stringify({ repoId: 'custom-repo-1' }),
      });

      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(403);
    });

    it('普通读者仅将自定义版本加入书架（拥有 SavedRepo）但非作者/维护者时，调用晋升被 403 严格拦截（防越权漏洞回归测试）', async () => {
      repoFindUniqueMock.mockResolvedValueOnce({
        id: 'custom-repo-1',
        owner: 'org',
        repo: 'project',
        edition: 'custom-ed',
        isPublic: true,
        reviewPipeline: { publishedBy: 'original-creator' },
      });
      // 当前用户仅保存了该仓库至书架，但既不是最早导入维护者，也没有 Document 或 ImportRecord
      importRecordFindFirstMock.mockResolvedValueOnce({ userId: 'original-creator' }); // resolveMaintainerUserId
      userFindUniqueMock.mockResolvedValueOnce({ role: 'USER', tier: 'FREE' });
      documentFindFirstMock.mockResolvedValueOnce(null); // ownsDoc = null
      importRecordFindFirstMock.mockResolvedValueOnce(null); // ownsImport = null
      savedRepoFindFirstMock.mockResolvedValueOnce({ id: 'saved-entry-1', userId: 'maintainer-1', repositoryId: 'custom-repo-1' });

      const { POST } = await import('@/app/api/repos/promote-edition/route');
      const req = new NextRequest('http://localhost/api/repos/promote-edition', {
        method: 'POST',
        body: JSON.stringify({ repoId: 'custom-repo-1' }),
      });

      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toContain('权限不足');
    });

    it('维护者成功晋升自定义版本：调用 sidecar，级联清理老默认版，失效主站/L1/路径缓存，返回 200', async () => {
      repoFindUniqueMock.mockResolvedValueOnce({
        id: 'custom-repo-1',
        owner: 'org',
        repo: 'project',
        branch: 'main',
        edition: 'custom-ed',
        isPublic: false,
        reviewPipeline: null,
      });
      // 维护者
      importRecordFindFirstMock.mockResolvedValueOnce({ userId: 'maintainer-1' });
      userFindUniqueMock.mockResolvedValueOnce({ role: 'USER', tier: 'FREE' });

      callSidecarMock.mockResolvedValueOnce({
        ok: true,
        promotedRepoId: 'custom-repo-1',
        oldDefaultRepoId: 'old-default-1',
        migratedSaves: 8,
      });

      const { POST } = await import('@/app/api/repos/promote-edition/route');
      const req = new NextRequest('http://localhost/api/repos/promote-edition', {
        method: 'POST',
        body: JSON.stringify({ repoId: 'custom-repo-1' }),
      });

      const res = await POST(req, { params: Promise.resolve({}) });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.repositoryId).toBe('custom-repo-1');
      expect(json.data.oldDefaultRepoId).toBe('old-default-1');
      expect(json.data.migratedSavesCount).toBe(8);

      // 验证 Sidecar 协议与调用
      expect(callSidecarMock).toHaveBeenCalledWith(
        '/v1/repos/promote-edition',
        { id: 'custom-repo-1', userId: 'maintainer-1' },
        { label: 'repo-promote-edition' }
      );

      // 验证多重缓存与 L1 投影失效
      expect(revalidateTagMock).toHaveBeenCalled();
      expect(invalidateWebL1ProjectionMock).toHaveBeenCalledWith('custom-repo-1');
      expect(invalidateWebL1ProjectionMock).toHaveBeenCalledWith('old-default-1');
      expect(invalidateWebL1ProjectionMock).toHaveBeenCalledWith('org/project');
      expect(revalidatePathMock).toHaveBeenCalledWith('/docs/org/project', 'layout');
    });

    it('旧默认版本不存在时，成功独立晋升为默认主版本，返回 200 并同步缓存', async () => {
      repoFindUniqueMock.mockResolvedValueOnce({
        id: 'custom-repo-standalone',
        owner: 'org',
        repo: 'project',
        branch: 'main',
        edition: 'custom-ed',
        isPublic: false,
        reviewPipeline: null,
      });
      // 维护者
      importRecordFindFirstMock.mockResolvedValueOnce({ userId: 'maintainer-1' });
      userFindUniqueMock.mockResolvedValueOnce({ role: 'USER', tier: 'FREE' });

      callSidecarMock.mockResolvedValueOnce({
        ok: true,
        promotedRepoId: 'custom-repo-standalone',
        migratedSaves: 0,
      });

      const { POST } = await import('@/app/api/repos/promote-edition/route');
      const req = new NextRequest('http://localhost/api/repos/promote-edition', {
        method: 'POST',
        body: JSON.stringify({ repoId: 'custom-repo-standalone' }),
      });

      const res = await POST(req, { params: Promise.resolve({}) });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.repositoryId).toBe('custom-repo-standalone');
      expect(json.data.oldDefaultRepoId).toBeUndefined();
      expect(json.data.migratedSavesCount).toBe(0);
      expect(invalidateWebL1ProjectionMock).toHaveBeenCalledWith('custom-repo-standalone');
    });
  });
});
