import { describe, it, expect, vi } from 'vitest';
import { tokenFingerprint, acquirePoolToken, markTokenCooldown, poolStats, __setPoolForTests } from '@/lib/github/token-pool';

const callSidecarMock = vi.fn().mockResolvedValue({ ok: true });
vi.mock('@/lib/sidecar-client', () => ({
  callSidecar: (...args: unknown[]) => callSidecarMock(...args),
}));

describe('M08 [8.4] GitHub Token Pool & Cooldown', () => {
  it('🧪 [8.4.1.1] 指纹算法返回 12 字符 SHA-256 前缀（anon 兜底与有效 token 标识）', () => {
    expect(tokenFingerprint('')).toBe('anon');
    const fp = tokenFingerprint('ghp_test1234567890abcdef');
    expect(fp.length).toBe(12);
    expect(fp).not.toBe('anon');
  });

  it('🧪 [8.4.2.1] 遇到 429 或限流 403 即时标记冷却，全池耗尽时优雅返回 undefined 降级', () => {
    try {
      // 注入两个候选 Token
      __setPoolForTests([{ value: 'token-alpha' }, { value: 'token-beta' }]);
      const fpAlpha = tokenFingerprint('token-alpha');
      const fpBeta = tokenFingerprint('token-beta');

      const initialStats = poolStats();
      expect(initialStats.size).toBe(2);
      expect(initialStats.healthy).toBe(2);

      // 1. 正常轮询选取
      const first = acquirePoolToken();
      expect(first).toBeDefined();
      expect(first?.value).toBe('token-alpha');

      // 2. 将 token-alpha 标记为冷却（如遭遇 429 / 403 限流）
      markTokenCooldown(fpAlpha, Date.now() + 60_000);

      // 3. 再次获取时自动跳过冷却中的 token-alpha，选用健康的 token-beta
      const second = acquirePoolToken();
      expect(second).toBeDefined();
      expect(second?.value).toBe('token-beta');

      // 4. 将 token-beta 也标记为冷却（全池耗尽）
      markTokenCooldown(fpBeta, Date.now() + 60_000);

      // 5. 全池耗尽时优雅降级返回 undefined，绝不抛错或阻塞
      const third = acquirePoolToken();
      expect(third).toBeUndefined();

      const drainedStats = poolStats();
      expect(drainedStats.healthy).toBe(0);
    } finally {
      // 恢复现场
      __setPoolForTests(null);
    }
  });

  it('🧪 [8.4.3.1] Token 配额采样日志记录 60s 节流，防止高并发打爆 DB', async () => {
    const { applyCrossInstanceCooldowns } = await import('@/lib/github/token-pool');
    const { githubFetch } = await import('@/lib/github/client');
    const { prisma } = await import('@/lib/db');

    // 1. 验证跨实例冷却吸收 30s 节流（防止高并发下频繁查库打爆 DB）
    const queryRawMock = vi.fn().mockResolvedValue([]);
    const originalQueryRaw = prisma.$queryRaw;
    (prisma as { $queryRaw: unknown }).$queryRaw = queryRawMock;

    try {
      const t0 = 10_000_000;
      await applyCrossInstanceCooldowns(t0);
      expect(queryRawMock).toHaveBeenCalledTimes(1);

      // 5 秒后再次并发调用（未满 30s 窗口）-> 节流直接跳过，零查库
      await applyCrossInstanceCooldowns(t0 + 5000);
      expect(queryRawMock).toHaveBeenCalledTimes(1);

      // 35 秒后调用（跨越 30s 窗口）-> 允许刷新并查库
      await applyCrossInstanceCooldowns(t0 + 35_000);
      expect(queryRawMock).toHaveBeenCalledTimes(2);
    } finally {
      (prisma as { $queryRaw: unknown }).$queryRaw = originalQueryRaw;
    }

    // 2. 验证配额日志采样节流（非紧急情况下按步长采样，紧急 < 200 必记）
    callSidecarMock.mockReset();
    callSidecarMock.mockResolvedValue({ ok: true });

    const originalFetch = globalThis.fetch;
    let remainingHeader = '4500';
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response('{}', {
          status: 200,
          headers: {
            'x-ratelimit-remaining': remainingHeader,
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
          },
        })
      )
    );

    try {
      // 触发紧急额度写入：remaining = 50 (< 200) -> 必记，不受计数器步长抑制
      remainingHeader = '50';
      await githubFetch('https://api.github.com/zen');
      // 等待异步 fire-and-forget
      await vi.waitFor(() => {
        expect(callSidecarMock).toHaveBeenCalledWith(
          '/v1/github/quota/sample',
          expect.objectContaining({ remaining: 50 }),
          expect.anything()
        );
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('🧪 [8.4.1.1] 遇到 401 Bad Credentials 立即移入隔离池 (markTokenQuarantined)，健康池自动剔除', async () => {
    const { markTokenQuarantined, isTokenQuarantined, clearQuarantinedForTests } = await import('@/lib/github/token-pool');
    try {
      __setPoolForTests([{ value: 'token-valid' }, { value: 'token-bad' }]);
      const fpBad = tokenFingerprint('token-bad');
      const fpValid = tokenFingerprint('token-valid');

      expect(isTokenQuarantined(fpBad)).toBe(false);

      // 模拟探测到 401
      markTokenQuarantined(fpBad);
      expect(isTokenQuarantined(fpBad)).toBe(true);
      expect(isTokenQuarantined(fpValid)).toBe(false);

      const stats = poolStats();
      expect(stats.size).toBe(2);
      expect(stats.healthy).toBe(1);
      expect(stats.quarantined).toBe(1);

      // 轮询多次，只会获取到 token-valid，绝对不会选中 token-bad
      for (let i = 0; i < 5; i++) {
        const t = acquirePoolToken();
        expect(t).toBeDefined();
        expect(t?.value).toBe('token-valid');
      }

      // 如果 token-valid 也被隔离，则全池隔离返回 undefined
      markTokenQuarantined(fpValid);
      expect(acquirePoolToken()).toBeUndefined();
      expect(poolStats().healthy).toBe(0);
      expect(poolStats().quarantined).toBe(2);
    } finally {
      clearQuarantinedForTests();
      __setPoolForTests(null);
    }
  });
});
