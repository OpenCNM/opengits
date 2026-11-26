import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 限流驱动单测：
 * 内存固定窗口语义回归 / Redis 滑动窗口管线 / fail-open 契约 /
 * 驱动选择与测试注入点。
 */

type Driver = { hit(key: string, limit: number, windowMs: number): Promise<boolean>; name: string };

describe('rate-limit 驱动', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.REDIS_URL;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function memMod() {
    const mod = await import('@/lib/rate-limit');
    return mod;
  }

  it('默认驱动为 memory(未配 REDIS_URL)', async () => {
    const mod = await memMod();
    expect(mod.rateLimitDriverName()).toBe('memory');
  });

  it('内存窗口:限额内放行,超限拒绝,窗口翻新后重置', async () => {
    vi.useFakeTimers();
    const mod = await memMod();
    const t0 = Date.now();

    await expect(mod.checkRateLimit('u1', 2, 60_000)).resolves.toBe(true);
    await expect(mod.checkRateLimit('u1', 2, 60_000)).resolves.toBe(true);
    await expect(mod.checkRateLimit('u1', 2, 60_000)).resolves.toBe(false); // 超限

    vi.advanceTimersByTime(t0 % 60_000 === 0 ? 61_000 : 61_000);
    await expect(mod.checkRateLimit('u1', 2, 60_000)).resolves.toBe(true); // 窗口已翻新
  });

  it('不同 identifier 相互隔离', async () => {
    const mod = await memMod();
    await expect(mod.checkRateLimit('a', 1, 60_000)).resolves.toBe(true);
    await expect(mod.checkRateLimit('b', 1, 60_000)).resolves.toBe(true);
    await expect(mod.checkRateLimit('a', 1, 60_000)).resolves.toBe(false);
  });

  it('注入故障驱动 → checkRateLimit 兜底放行(fail-open)', async () => {
    const mod = await memMod();
    const bad: Driver = {
      name: 'bad',
      hit: () => Promise.reject(new Error('driver exploded')),
    };
    mod.__setRateLimitDriverForTests(bad);
    await expect(mod.checkRateLimit('x', 1, 1000)).resolves.toBe(true);
  });

  it('Redis 驱动:zcard 计数 ≤ limit 放行,> limit 拒绝;异常时 fail-open', async () => {
    process.env.REDIS_URL = 'redis://localhost:6399';
    // ioredis 动态 import 打桩：可控的 multi() 管线
    const zcardQueue: number[] = [];
    let throwOnExec = false;
    vi.doMock('ioredis', () => ({
      default: class {
        status = 'ready';
        on = vi.fn();
        connect = vi.fn().mockResolvedValue(undefined);
        multi() {
          type Cmd = [string, ...unknown[]];
          const cmds: Cmd[] = [];
          const pipe = {
            zremrangebyscore(...a: unknown[]) { cmds.push(['zr', ...a]); return pipe; },
            zadd(...a: unknown[]) { cmds.push(['za', ...a]); return pipe; },
            zcard(...a: unknown[]) { cmds.push(['zc', ...a]); return pipe; },
            pexpire(...a: unknown[]) { cmds.push(['pe', ...a]); return pipe; },
            exec: async () => {
              if (throwOnExec) throw new Error('redis down');
              return [
                [null, 0],
                [null, 1],
                [null, zcardQueue.shift() ?? 0],
                [null, 1],
              ];
            },
          };
          return pipe;
        }
      },
    }));

    const mod = await import('@/lib/rate-limit');
    expect(mod.rateLimitDriverName()).toBe('redis');

    zcardQueue.push(3);
    await expect(mod.checkRateLimit('chat:u1', 5, 60_000)).resolves.toBe(true); // 3 ≤ 5

    zcardQueue.push(9);
    await expect(mod.checkRateLimit('chat:u1', 5, 60_000)).resolves.toBe(false); // 9 > 5

    throwOnExec = true;
    await expect(mod.checkRateLimit('chat:u1', 5, 60_000)).resolves.toBe(true); // fail-open
  });
});
