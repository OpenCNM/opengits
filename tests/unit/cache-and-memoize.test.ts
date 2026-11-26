import { test, expect, describe, it, vi } from 'vitest';
import { TtlCache } from '@/lib/cache/ttl-cache';
import { createTtlMicroCache } from '@/lib/docs/ttl-microcache';
import {
  memoizeOne,
  createMemoizedSelector,
  createMemoizedObjectSelector,
  shallowArrayEqual,
  shallowObjectEqual,
} from '@/lib/stores/memoize-selector';

describe('ttl-cache & ttl-microcache', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('TtlCache: TTL 过期重加载、单飞防击穿、失败不缓存与 null 缓存', async () => {
    const cache = new TtlCache<string>(30, 100);
    let loads = 0;
    const loader = async () => `v${++loads}`;
    expect(await cache.getOrLoad('k', loader)).toBe('v1');
    expect(await cache.getOrLoad('k', loader)).toBe('v1');
    expect(loads).toBe(1);
    await sleep(40);
    expect(await cache.getOrLoad('k', loader)).toBe('v2');
    expect(loads).toBe(2);

    const singleFlight = new TtlCache<number>(1000, 100);
    let sfLoads = 0;
    const slow = async () => {
      sfLoads++;
      await sleep(25);
      return sfLoads;
    };
    const [a, b, c] = await Promise.all([singleFlight.getOrLoad('k', slow), singleFlight.getOrLoad('k', slow), singleFlight.getOrLoad('k', slow)]);
    expect([sfLoads, a, b, c]).toEqual([1, 1, 1, 1]);

    const errCache = new TtlCache<string>(1000, 100);
    let attempts = 0;
    const flaky = async () => {
      if (++attempts === 1) throw new Error('db down');
      return 'ok';
    };
    await expect(errCache.getOrLoad('k', flaky)).rejects.toThrow('db down');
    expect(await errCache.getOrLoad('k', flaky)).toBe('ok');
    expect(attempts).toBe(2);

    const nullCache = new TtlCache<string | null>(1000, 100);
    let nullLoads = 0;
    expect(await nullCache.getOrLoad('m', async () => { nullLoads++; return null; })).toBeNull();
    expect(await nullCache.getOrLoad('m', async () => { nullLoads++; return null; })).toBeNull();
    expect(nullLoads).toBe(1);
  });

  test('TtlCache & TtlMicroCache: 容量上限淘汰与 clear / TTL 过期', () => {
    const cache = new TtlCache<number>(10_000, 3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4);
    expect([cache.size, cache.get('a'), cache.get('b'), cache.get('d')]).toEqual([3, undefined, 2, 4]);
    cache.clear();
    expect([cache.size, cache.get('b')]).toEqual([0, undefined]);

    vi.useFakeTimers();
    const micro = createTtlMicroCache<number>(10_000, 2);
    micro.set('k', 42);
    vi.advanceTimersByTime(9_999);
    expect(micro.get('k')).toBe(42);
    vi.advanceTimersByTime(1);
    expect(micro.get('k')).toBeUndefined();
    vi.useRealTimers();

    micro.set('a', 1);
    micro.set('b', 2);
    micro.set('c', 3);
    expect([micro.size, micro.get('a'), micro.get('b'), micro.get('c')]).toEqual([2, undefined, 2, 3]);
    micro.clear();
    expect(micro.get('b')).toBeUndefined();
  });
});

describe('memoize-selector', () => {
  it('shallowArrayEqual & shallowObjectEqual 浅比较与非对象/数组边界', () => {
    const arr = [1, 2, 3];
    const obj = { id: 'x' };
    expect(shallowArrayEqual(arr, arr)).toBe(true);
    expect(shallowArrayEqual(null, null)).toBe(true);
    expect(shallowArrayEqual(arr, null)).toBe(false);
    expect(shallowArrayEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(shallowArrayEqual(['a', obj], ['a', obj])).toBe(true);
    expect(shallowArrayEqual(['a', obj], ['a', { id: 'x' }])).toBe(false);
    expect(shallowArrayEqual({ length: 0 } as any, { length: 0 } as any)).toBe(false);

    const o = { a: 1, b: '2' };
    const inner = [1, 2];
    expect(shallowObjectEqual(o, o)).toBe(true);
    expect(shallowObjectEqual(null, null)).toBe(true);
    expect(shallowObjectEqual(o, null)).toBe(false);
    expect(shallowObjectEqual(123 as any, 456 as any)).toBe(false);
    expect(shallowObjectEqual([1] as any, [1] as any)).toBe(false);
    expect(shallowObjectEqual({ a: 1 }, { a: 1, b: 2 } as any)).toBe(false);
    expect(shallowObjectEqual({ a: 1, c: 2 } as any, { a: 1, b: 2 } as any)).toBe(false);
    expect(shallowObjectEqual({ a: 1, b: inner }, { a: 1, b: inner })).toBe(true);
    expect(shallowObjectEqual({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toBe(false);
  });

  it('memoizeOne: 恒等引用缓存、参数变化重算、自定义判等与 clear', () => {
    const spy = vi.fn((a: number, b: string) => ({ sum: `${a}-${b}` }));
    const memoized = memoizeOne(spy);
    const r1 = memoized(1, 'apple');
    expect(memoized(1, 'apple')).toBe(r1);
    expect(spy).toHaveBeenCalledTimes(1);

    const r2 = memoized(2, 'apple');
    expect(r2).not.toBe(r1);
    expect(memoized(2, 'apple')).toBe(r2);
    expect(spy).toHaveBeenCalledTimes(2);

    memoized.clear();
    expect(memoized(2, 'apple')).not.toBe(r2);
    expect(spy).toHaveBeenCalledTimes(3);

    const customSpy = vi.fn((arg: { id: string; timestamp: number }) => ({ processedId: arg.id }));
    const customMemo = memoizeOne(customSpy, (p, n) => p[0].id === n[0].id);
    const c1 = customMemo({ id: 'doc-1', timestamp: 100 });
    expect(customMemo({ id: 'doc-1', timestamp: 200 })).toBe(c1);
    expect(customMemo({ id: 'doc-2', timestamp: 300 })).not.toBe(c1);
    expect(customSpy).toHaveBeenCalledTimes(2);
  });

  it('createMemoizedSelector: 无关状态高频变动保持引用恒定', () => {
    interface StoreState {
      documents: Array<{ id: string; status: string }>;
      activeId: string | null;
      unrelatedCounter: number;
    }
    const selector = createMemoizedSelector(
      (state: StoreState) => ({
        total: state.documents.length,
        active: state.documents.find((d) => d.id === state.activeId) ?? null,
        processed: state.documents.filter((d) => d.status === 'DONE').length,
      }),
      (prev, next) => prev.documents === next.documents && prev.activeId === next.activeId
    );
    const sharedDocs = [{ id: '1', status: 'DONE' }, { id: '2', status: 'PENDING' }];
    let state: StoreState = { documents: sharedDocs, activeId: '1', unrelatedCounter: 0 };
    const initial = selector(state);
    for (let i = 1; i <= 50; i++) {
      state = { ...state, unrelatedCounter: i };
      expect(selector(state)).toBe(initial);
    }
    state = { ...state, documents: [...sharedDocs, { id: '3', status: 'PENDING' }] };
    const next = selector(state);
    expect(next).not.toBe(initial);
    expect(next.total).toBe(3);
    expect(selector(state)).toBe(next);
  });

  it('createMemoizedObjectSelector: SSR 恒等引用与输出端浅比较防御', () => {
    interface TestStore {
      step: number;
      loading: boolean;
      counter: number;
    }
    const selector = createMemoizedObjectSelector((s: TestStore) => ({
      status: s.loading ? 'loading' : 'ready',
      step: s.step,
    }));
    const s1: TestStore = { step: 1, loading: false, counter: 0 };
    const s2: TestStore = { step: 1, loading: false, counter: 1 };
    const s3: TestStore = { step: 2, loading: false, counter: 1 };
    const r1 = selector(s1);
    expect(selector(s1)).toBe(r1);
    expect(selector(s2)).toBe(r1);
    const r3 = selector(s3);
    expect(r3).not.toBe(r1);
    expect(r3.step).toBe(2);
    expect(selector(s3)).toBe(r3);
  });
});
