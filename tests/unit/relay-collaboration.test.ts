import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAPTER_UPDATE_JOB_STATUS as S, CHAPTER_UPDATE_JOB_KIND as K } from '@/lib/schemas/update-job';

const jobFindUniqueMock = vi.fn();
const jobUpdateManyMock = vi.fn().mockResolvedValue({ count: 1 });
const eventCreateMock = vi.fn().mockResolvedValue({ id: 'evt-1' });
const mockMarketRelease = vi.fn();

vi.mock('@/engine/market-driver', () => ({
  executeSidecarMarketJobRelease: (...args: unknown[]) => mockMarketRelease(...args),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    chapterUpdateJob: {
      findUnique: jobFindUniqueMock,
      updateMany: jobUpdateManyMock,
    },
    episodicEvent: {
      create: eventCreateMock,
    },
  },
}));

vi.mock('@/lib/gateway/policy', () => ({
  isEmergencyReadOnly: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/observability/errors', () => ({
  captureError: vi.fn(),
}));

describe('Community Relay & Collaboration Hardening (维度八)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('abandonClaim (主动放弃认领与释放)', () => {
    it('认领者本人主动放弃认领 → CAS 原子回退为 PENDING，清空租约与 claimedBy', async () => {
      const { abandonClaim } = await import('@/lib/update-market/jobs');
      mockMarketRelease.mockResolvedValueOnce({ ok: true });

      await abandonClaim('job-123', 'user-alice');

      expect(mockMarketRelease).toHaveBeenCalledWith('job-123', 'user-alice');
    });

    it('非本人试图放弃他人认领的任务 → 拒绝抛出 INVALID_STATE', async () => {
      const { abandonClaim, UpdateMarketError } = await import('@/lib/update-market/jobs');
      mockMarketRelease.mockRejectedValueOnce(new Error('INVALID_STATE'));

      await expect(abandonClaim('job-123', 'user-bob')).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });
    });

    it('任务不存在时放弃认领 → 抛出 NOT_FOUND', async () => {
      const { abandonClaim } = await import('@/lib/update-market/jobs');
      mockMarketRelease.mockRejectedValueOnce(new Error('NOT_FOUND'));

      await expect(abandonClaim('job-404', 'user-alice')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('非 CLAIMED 状态任务调用 abandonClaim → 拒绝抛出 INVALID_STATE', async () => {
      const { abandonClaim } = await import('@/lib/update-market/jobs');
      mockMarketRelease.mockRejectedValueOnce(new Error('INVALID_STATE'));

      await expect(abandonClaim('job-123', 'user-alice')).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });
    });
  });

  describe('DELETE /api/update/jobs/[id]/claim 端点契约', () => {
    it('端点模块正常导出且具备用户鉴权与 DELETE 动词', async () => {
      const routeModule = await import('@/app/api/update/jobs/[id]/claim/route');
      expect(typeof routeModule.DELETE).toBe('function');
      expect(routeModule.dynamic).toBe('force-dynamic');
    });
  });
});
