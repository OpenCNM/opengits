import { describe, it, expect, vi } from 'vitest';
import { withRequestMemo } from '@/lib/docs/docs-page-loader';

// 与 docs-page-loader-cache.test.ts 同口径：模块级 PrismaClient 实例化防护
vi.mock('@/lib/db', () => ({
  prisma: {},
}));

/**
 * 请求级 memo 组合语义锁定（性能修复 2026-10-13）：
 * generateMetadata 与 Page 同请求各调用一次 loadDocPageData，靠该组合去重。
 * 语义契约：
 * 1. 同 key 并发/串行调用共享同一 Promise（loader 只执行一次）；
 * 2. loader 失败即从 store 删除条目——失败后的下一次调用重新执行
 *    （metadata 阶段失败不污染 Page 的重试语义）；
 * 3. 不同 key 互不影响。
 */
describe('withRequestMemo', () => {
  it('shares a single loader execution for concurrent calls with the same key', async () => {
    const store = new Map<string, Promise<number>>();
    const loader = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    });

    const [a, b] = await Promise.all([
      withRequestMemo(store, 'k', loader),
      withRequestMemo(store, 'k', loader),
    ]);

    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(store.has('k')).toBe(true);
  });

  it('reuses the settled promise for sequential calls without re-executing the loader', async () => {
    const store = new Map<string, Promise<number>>();
    const loader = vi.fn(async () => 7);

    await withRequestMemo(store, 'k', loader);
    const second = await withRequestMemo(store, 'k', loader);

    expect(second).toBe(7);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('deletes the entry on failure so the next call re-executes the loader', async () => {
    const store = new Map<string, Promise<number>>();
    let attempts = 0;
    const loader = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
      return 99;
    });

    await expect(withRequestMemo(store, 'k', loader)).rejects.toThrow('transient');
    expect(store.has('k')).toBe(false);

    // 失败后条目已删除：第二次调用重新执行并成功（保留瞬时错误重试语义）
    const recovered = await withRequestMemo(store, 'k', loader);
    expect(recovered).toBe(99);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('isolates different keys', async () => {
    const store = new Map<string, Promise<number>>();
    const loaderA = vi.fn(async () => 1);
    const loaderB = vi.fn(async () => 2);

    const [a, b] = await Promise.all([
      withRequestMemo(store, 'a', loaderA),
      withRequestMemo(store, 'b', loaderB),
    ]);

    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(loaderA).toHaveBeenCalledTimes(1);
    expect(loaderB).toHaveBeenCalledTimes(1);
  });

  it('does not poison later callers when a concurrent call already holds the failing promise', async () => {
    // 两个并发调用共享同一 rejected Promise（各自收到同一失败）——
    // 只有失败之后到达的新调用才会重新执行
    const store = new Map<string, Promise<number>>();
    const loader = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(
      Promise.allSettled([withRequestMemo(store, 'k', loader), withRequestMemo(store, 'k', loader)])
    ).resolves.toHaveLength(2);
    expect(store.has('k')).toBe(false);
  });
});
