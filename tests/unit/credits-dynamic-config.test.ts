import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  getDynamicCreditsConfig,
  invalidateCreditsConfigCache,
  estimateRequiredCredits,
} from '@/lib/credits-config';
import { getResetWindowBounds } from '@/lib/credits-ledger';

vi.mock('@/lib/db', () => ({
  prisma: {
    platformCreditsConfig: {
      findUnique: vi.fn(),
    },
  },
}));

describe('Dynamic Credits Configuration & Reset Window (全站动态积分与周期重置)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCreditsConfigCache();
  });

  it('DB 查空或故障时：优雅降级为静态标准默认值 (1000 积分 / 24h)', async () => {
    const { prisma } = await import('@/lib/db');
    (prisma.platformCreditsConfig.findUnique as any).mockResolvedValueOnce(null);

    const config = await getDynamicCreditsConfig();
    expect(config.defaultDailyCredits).toBe(1000);
    expect(config.resetIntervalHours).toBe(24);
    expect(config.maxCreditsPerImport).toBe(300);
    });

  it('DB 返回自定义配置时：正确读取并应用内存微缓存', async () => {
    const { prisma } = await import('@/lib/db');
    (prisma.platformCreditsConfig.findUnique as any).mockResolvedValueOnce({
      id: 'singleton',
      defaultDailyCredits: 1500,
      resetIntervalHours: 12,
      maxCreditsPerImport: 500,
      codePedagogyMultiplier: 2.5,
      standardChunkCharSize: 1200,
    });

    const config1 = await getDynamicCreditsConfig();
    expect(config1.defaultDailyCredits).toBe(1500);
    expect(config1.resetIntervalHours).toBe(12);
    expect(config1.maxCreditsPerImport).toBe(500);

    // 第二次调用走 10s 内存缓存，不再打 DB
    const config2 = await getDynamicCreditsConfig();
    expect(config2.defaultDailyCredits).toBe(1500);
    expect(prisma.platformCreditsConfig.findUnique).toHaveBeenCalledTimes(1);

    // 手动失效后重新读取
    invalidateCreditsConfigCache();
    (prisma.platformCreditsConfig.findUnique as any).mockResolvedValueOnce({
      id: 'singleton',
      defaultDailyCredits: 2000,
      resetIntervalHours: 48,
    });
    const config3 = await getDynamicCreditsConfig();
    expect(config3.defaultDailyCredits).toBe(2000);
    expect(config3.resetIntervalHours).toBe(48);
  });

  describe('getResetWindowBounds (动态滚动重置时间窗口计算)', () => {
    it('24 小时周期：起始对齐当天的 00:00:00.000 UTC，结束为次日 00:00:00.000 UTC', () => {
      const fixedDate = new Date('2026-08-26T10:15:30.000Z');
      const { start, end, nextResetAt } = getResetWindowBounds(fixedDate, 24);

      expect(start.toISOString()).toBe('2026-08-26T00:00:00.000Z');
      expect(nextResetAt.toISOString()).toBe('2026-08-27T00:00:00.000Z');
      expect(end.getTime()).toBe(nextResetAt.getTime() - 1);
    });

    it('12 小时周期：上午 10 点处于 00:00~12:00 窗口，下次重置时刻为 12:00:00.000 UTC', () => {
      const fixedDate = new Date('2026-08-26T10:15:30.000Z');
      const { start, nextResetAt } = getResetWindowBounds(fixedDate, 12);

      expect(start.toISOString()).toBe('2026-08-26T00:00:00.000Z');
      expect(nextResetAt.toISOString()).toBe('2026-08-26T12:00:00.000Z');
    });

    it('12 小时周期：下午 16 点处于 12:00~24:00 窗口，下次重置时刻为次日 00:00:00.000 UTC', () => {
      const fixedDate = new Date('2026-08-26T16:45:00.000Z');
      const { start, nextResetAt } = getResetWindowBounds(fixedDate, 12);

      expect(start.toISOString()).toBe('2026-08-26T12:00:00.000Z');
      expect(nextResetAt.toISOString()).toBe('2026-08-27T00:00:00.000Z');
    });

  });

  describe('estimateRequiredCredits (动态配置换算)', () => {
    it('应用动态标准字符量与 0 消耗', () => {
      const customConfig = {
        standardChunkCharSize: 1000,
        codePedagogyMultiplier: 3.0,
      };

      // 3000 字符 -> 3 chunks -> 3 base -> 导入转录 0 消耗，公开全额奖励
      const res = estimateRequiredCredits(
        { totalChars: 3000, docCount: 1, isPublic: true },
        customConfig
      );
      expect(res.estimatedChunks).toBe(3);
      expect(res.baseCredits).toBe(3);
      expect(res.finalCredits).toBe(0);
      expect(res.rewardCredits).toBe(3);
      expect(res.discountApplied).toBe(true);
    });

    it('公开导入：转录消耗积分为 0，奖励为 baseCredits', () => {
      const res = estimateRequiredCredits(
        { totalChars: 3000, docCount: 2, isPublic: true }
      );
      expect(res.baseCredits).toBe(2);
      expect(res.finalCredits).toBe(0);
      expect(res.rewardCredits).toBe(2);
      expect(res.discountApplied).toBe(true);
    });

    it('私有导入：转录 0 消耗且 0 奖励', () => {
      const resPrivate = estimateRequiredCredits(
        { totalChars: 4500, docCount: 3, isPublic: false }
      );
      expect(resPrivate.baseCredits).toBe(3);
      expect(resPrivate.finalCredits).toBe(0);
      expect(resPrivate.rewardCredits).toBe(0);
      expect(resPrivate.discountApplied).toBe(false);
    });

    it('默认全站配置：公开导入 0 消耗且全额体量奖励（-1.0x）', () => {
      const res = estimateRequiredCredits({
        totalChars: 3000,
        docCount: 2,
        isPublic: true,
      });
      expect(res.baseCredits).toBe(2);
      expect(res.finalCredits).toBe(0);
      expect(res.rewardCredits).toBe(2);
      expect(res.discountApplied).toBe(true);
    });
  });

  // describe「Admin Credits Config PUT — Partial Update Protection (半量更新保护)」
  // 随 admin 拆分迁至私有仓 tests/unit/credits-dynamic-config.admin.test.ts
});
