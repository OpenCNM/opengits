import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  CREDITS_CONFIG,
  getDynamicCreditsConfig,
  invalidateCreditsConfigCache,
} from '@/lib/credits-config';
import {
  UnpublishRepositoryInputSchema,
} from '@/lib/schemas/credit-grant';

const adminAuditLogCreateMock = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const repoFindUniqueMock = vi.hoisted(() => vi.fn());
const repoFindFirstMock = vi.hoisted(() => vi.fn());
const userFindUniqueMock = vi.hoisted(() => vi.fn());
const importRecordFindFirstMock = vi.hoisted(() => vi.fn());
const callSidecarMock = vi.hoisted(() => vi.fn());
const revalidateTagMock = vi.hoisted(() => vi.fn());
const invalidateWebL1ProjectionMock = vi.hoisted(() => vi.fn());
const getSessionHelperMock = vi.hoisted(() => vi.fn());
const getAdminUserHelperMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => {
  const txObj = {
    adminAuditLog: { create: adminAuditLogCreateMock },
  };
  return {
    prisma: {
      platformCreditsConfig: {
        findUnique: vi.fn(),
      },
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
      adminAuditLog: { create: adminAuditLogCreateMock },
      $transaction: vi.fn(async (fn: (tx: typeof txObj) => unknown) => fn(txObj)),
    },
  };
});

vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: callSidecarMock,
}));

vi.mock('next/cache', () => ({
  revalidateTag: revalidateTagMock,
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

describe('Creator Credit Vesting & Two-Phase Unpublish Test Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCreditsConfigCache();
    getSessionHelperMock.mockResolvedValue({
      user: { id: 'maintainer-1', email: 'maintainer@example.com' },
    });
    getAdminUserHelperMock.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
    });
  });

  describe('1. Platform Credits Config Vesting Parameters', () => {
    it('静态默认值包含 CONTRIBUTION_VESTING_DAYS (7) 与 INITIAL_PUBLISH_REWARD_RATIO (0.0)', () => {
      expect(CREDITS_CONFIG.CONTRIBUTION_VESTING_DAYS).toBe(7);
      expect(CREDITS_CONFIG.INITIAL_PUBLISH_REWARD_RATIO).toBe(0.0);
    });

    it('DB 未配置或为空时回退默认归属期与初始发放比率', async () => {
      const { prisma } = await import('@/lib/db');
      (prisma.platformCreditsConfig.findUnique as any).mockResolvedValueOnce(null);

      const cfg = await getDynamicCreditsConfig();
      expect(cfg.contributionVestingDays).toBe(7);
      expect(cfg.initialPublishRewardRatio).toBe(0.0);
    });

    it('DB 配置时正确解析并提供有效数值', async () => {
      const { prisma } = await import('@/lib/db');
      (prisma.platformCreditsConfig.findUnique as any).mockResolvedValueOnce({
        id: 'singleton',
        contributionVestingDays: 14,
        initialPublishRewardRatio: 0.5,
      });

      const cfg = await getDynamicCreditsConfig();
      expect(cfg.contributionVestingDays).toBe(14);
      expect(cfg.initialPublishRewardRatio).toBe(0.5);
    });
  });

  // describe 2（Admin Dynamic PUT Config Route with Vesting Settings）随 admin 拆分
  // 迁至私有仓 tests/unit/unpublish-and-vesting.admin.test.ts

  describe('3. Zod Schemas for Unpublish', () => {
    it('UnpublishRepositoryInputSchema 验证：必须提供 repoId 或 (owner + repo)', () => {
      const validById = UnpublishRepositoryInputSchema.safeParse({ repoId: 'repo-123' });
      expect(validById.success).toBe(true);

      const validByOwnerRepo = UnpublishRepositoryInputSchema.safeParse({
        owner: 'facebook',
        repo: 'react',
      });
      expect(validByOwnerRepo.success).toBe(true);

      const invalidEmpty = UnpublishRepositoryInputSchema.safeParse({});
      expect(invalidEmpty.success).toBe(false);

      const invalidOwnerOnly = UnpublishRepositoryInputSchema.safeParse({
        owner: 'facebook',
      });
      expect(invalidOwnerOnly.success).toBe(false);
    });
  });

  describe('4. POST /api/repos/unpublish 路由逻辑与授权控制', () => {
    it('未登录时返回 401 UNAUTHORIZED', async () => {
      getSessionHelperMock.mockResolvedValueOnce(null);

      const { POST } = await import('@/app/api/repos/unpublish/route');
      const req = new NextRequest('http://localhost/api/repos/unpublish', {
        method: 'POST',
        body: JSON.stringify({ repoId: 'repo-123' }),
      });

      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(401);
    });

    it('仓库不存在时返回 404 NOT_FOUND', async () => {
      repoFindUniqueMock.mockResolvedValueOnce(null);

      const { POST } = await import('@/app/api/repos/unpublish/route');
      const req = new NextRequest('http://localhost/api/repos/unpublish', {
        method: 'POST',
        body: JSON.stringify({ repoId: 'non-existent' }),
      });

      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(404);
    });

    it('非维护者/发布者/管理员调用返回 403 FORBIDDEN', async () => {
      repoFindUniqueMock.mockResolvedValueOnce({
        id: 'repo-123',
        owner: 'org',
        repo: 'repo',
        isPublic: true,
        reviewPipeline: { publishedBy: 'other-user' },
      });
      importRecordFindFirstMock.mockResolvedValueOnce({ userId: 'another-user' });
      userFindUniqueMock.mockResolvedValueOnce({ role: 'USER' });

      const { POST } = await import('@/app/api/repos/unpublish/route');
      const req = new NextRequest('http://localhost/api/repos/unpublish', {
        method: 'POST',
        body: JSON.stringify({ repoId: 'repo-123' }),
      });

      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(403);
    });

    it('当前非公开教程调用下架返回 400 BAD_REQUEST 防越权', async () => {
      repoFindUniqueMock.mockResolvedValueOnce({
        id: 'repo-123',
        owner: 'org',
        repo: 'repo',
        isPublic: false,
        reviewPipeline: null,
      });
      importRecordFindFirstMock.mockResolvedValueOnce({ userId: 'maintainer-1' });
      userFindUniqueMock.mockResolvedValueOnce({ role: 'USER' });

      const { POST } = await import('@/app/api/repos/unpublish/route');
      const req = new NextRequest('http://localhost/api/repos/unpublish', {
        method: 'POST',
        body: JSON.stringify({ repoId: 'repo-123' }),
      });

      const res = await POST(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('无需下架');
    });

    it('维护者成功下架：调用 sidecar，触发主站与投影缓存失效，返回 200 信封', async () => {
      repoFindUniqueMock.mockResolvedValueOnce({
        id: 'repo-123',
        owner: 'org',
        repo: 'repo',
        isPublic: true,
        reviewPipeline: null,
      });
      importRecordFindFirstMock.mockResolvedValueOnce({ userId: 'maintainer-1' });
      userFindUniqueMock.mockResolvedValueOnce({ role: 'USER' });

      callSidecarMock.mockResolvedValueOnce({
        ok: true,
        isPublic: false,
        cancelledPendingGrantsCount: 2,
        detachedSavedReposCount: 5,
      });

      const { POST } = await import('@/app/api/repos/unpublish/route');
      const req = new NextRequest('http://localhost/api/repos/unpublish', {
        method: 'POST',
        body: JSON.stringify({ repoId: 'repo-123' }),
      });

      const res = await POST(req, { params: Promise.resolve({}) });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.isPublic).toBe(false);
      expect(json.data.cancelledPendingGrantsCount).toBe(2);
      expect(json.data.detachedSavedReposCount).toBe(5);
      expect(callSidecarMock).toHaveBeenCalledWith(
        '/v1/repos/unpublish',
        { id: 'repo-123', userId: 'maintainer-1' },
        { label: 'repo-unpublish' }
      );
      expect(revalidateTagMock).toHaveBeenCalled();
      expect(invalidateWebL1ProjectionMock).toHaveBeenCalledWith('repo-123');
    });
  });

});
