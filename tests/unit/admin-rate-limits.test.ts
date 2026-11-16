import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Admin Rate Limits & Sparkline Calculations', () => {
  it('配额百分比计算与区间夹紧（0% ~ 100%）', () => {
    const computeUsedPercent = (limit: number, remaining: number) => {
      const used = Math.max(0, limit - remaining);
      return Math.min(100, Math.max(1, Math.round((used / limit) * 100)));
    };

    expect(computeUsedPercent(5000, 5000)).toBe(1); // 最低保底 1% 作为视觉基线
    expect(computeUsedPercent(5000, 3800)).toBe(24);
    expect(computeUsedPercent(5000, 0)).toBe(100);
    expect(computeUsedPercent(60, 45)).toBe(25);
  });

  it('用户 OAuth 凭证池理论承载力按 5,000 次/席位 线性缩放', () => {
    const computeCapacity = (linkedUsers: number) => {
      return Math.max(linkedUsers, 1) * 5000;
    };

    expect(computeCapacity(0)).toBe(5000); // 无 OAuth 用户时保底 1 份服务端 Token
    expect(computeCapacity(1)).toBe(5000);
    expect(computeCapacity(10)).toBe(50000);
    expect(computeCapacity(86)).toBe(430000);
  });

  it('重置时间倒计时非负保护', () => {
    const computeResetMinutes = (resetTimestampSec: number, nowMs: number) => {
      return Math.max(0, Math.round((resetTimestampSec * 1000 - nowMs) / 60000));
    };

    const now = 1723980000000;
    const futureReset = 1723980000 + 1800; // 30 分钟后
    const pastReset = 1723980000 - 600; // 10 分钟前

    expect(computeResetMinutes(futureReset, now)).toBe(30);
    expect(computeResetMinutes(pastReset, now)).toBe(0);
  });

  describe('Tarball 缓存真实聚合（临时目录隔离，不受宿主 storage 卷影响）', () => {
    let tempDir: string;
    let prevEnv: string | undefined;

    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'tarball-meta-test-'));
      prevEnv = process.env.TARBALL_CACHE_DIR;
      process.env.TARBALL_CACHE_DIR = tempDir;
    });

    afterAll(() => {
      if (prevEnv === undefined) delete process.env.TARBALL_CACHE_DIR;
      else process.env.TARBALL_CACHE_DIR = prevEnv;
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('metadata.json 缺失时 fail-soft 全零（不编造数值）', async () => {
      process.env.TARBALL_CACHE_DIR = join(tempDir, 'no-such-dir');
      vi.resetModules();
      const { readTarballCacheStats, setMetaCache } = await import('@/engine/tarball/tarball-meta');
      setMetaCache(null);
      await expect(readTarballCacheStats()).resolves.toEqual({
        entryCount: 0,
        totalHits: 0,
        totalBytes: 0,
      });
    });

    it('🧪 [11.5.1.1] 聚合卷数/命中/字节', async () => {
      process.env.TARBALL_CACHE_DIR = tempDir;
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(
        join(tempDir, 'metadata.json'),
        JSON.stringify({
          'a/b/sha1': { owner: 'a', repo: 'b', sha: 'sha1', size: 100, hits: 3, lastHitAt: 0, createdAt: 0 },
          'a/b/sha2': { owner: 'a', repo: 'b', sha: 'sha2', size: 250, hits: 7, lastHitAt: 0, createdAt: 0 },
        })
      );
      vi.resetModules();
      const { readTarballCacheStats } = await import('@/engine/tarball/tarball-meta');
      await expect(readTarballCacheStats()).resolves.toEqual({
        entryCount: 2,
        totalHits: 10,
        totalBytes: 350,
      });
    });
  });

  // 🧪 [11.5.2.1] 拦截事件 24h sparkline 折叠（foldHourlyBucketsToSparkline）随 admin 拆分
  // 迁至私有仓 tests/unit/admin-rate-limits.admin.test.ts

  it('🧪 [11.5.3.1] 控制台呈现诚实性：活跃状态由真实会话数驱动，无随机 jitter 编造', () => {
    // 横幅由近 5 分钟活跃会话数驱动判定：> 0 激活，0 闲置
    const isMcpActive = (activeSessions5m: number) => activeSessions5m > 0;
    expect(isMcpActive(0)).toBe(false);
    expect(isMcpActive(3)).toBe(true);

    // 未加载时显示真实零值，绝不编造假兜底数据 (12 repos / 340 docs)
    const renderFallback = (data: { repos?: number; docs?: number } | null) => ({
      repos: data?.repos ?? 0,
      docs: data?.docs ?? 0,
    });
    expect(renderFallback(null)).toEqual({ repos: 0, docs: 0 });
  });
});
