import { describe, expect, it, vi } from 'vitest';
import { createTtlMicroCache } from '@/lib/docs/ttl-microcache';

describe('TtlMicroCache（进程内秒级微缓存）', () => {
  it('TTL 内命中、过期后未命中', () => {
    vi.useFakeTimers();
    const cache = createTtlMicroCache<number>(10_000);
    cache.set('k', 42);
    expect(cache.get('k')).toBe(42);

    vi.advanceTimersByTime(9_999);
    expect(cache.get('k')).toBe(42);

    vi.advanceTimersByTime(1);
    expect(cache.get('k')).toBeUndefined();
    vi.useRealTimers();
  });

  it('容量上限 FIFO 淘汰最旧条目', () => {
    const cache = createTtlMicroCache<number>(60_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // 淘汰 a
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('clear 清空', () => {
    const cache = createTtlMicroCache<number>(60_000);
    cache.set('a', 1);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
  });
});
