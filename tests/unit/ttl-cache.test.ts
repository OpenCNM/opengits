import { test, expect } from 'vitest';
import { TtlCache } from '@/lib/cache/ttl-cache';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('TTL 过期后 miss 并重新加载', async () => {
  const cache = new TtlCache<string>(30, 100);
  let loads = 0;
  const loader = async () => {
    loads++;
    return `v${loads}`;
  };
  expect(await cache.getOrLoad('k', loader)).toBe('v1');
  expect(await cache.getOrLoad('k', loader)).toBe('v1'); // 命中
  expect(loads).toBe(1);
  await sleep(40); // 过 TTL
  expect(await cache.getOrLoad('k', loader)).toBe('v2');
  expect(loads).toBe(2);
});

test('单飞：并发冷启动同 key 只触发一次 loader（防击穿）', async () => {
  const cache = new TtlCache<number>(1000, 100);
  let loads = 0;
  const slowLoader = async () => {
    loads++;
    await sleep(30);
    return loads;
  };
  const [a, b, c] = await Promise.all([
    cache.getOrLoad('k', slowLoader),
    cache.getOrLoad('k', slowLoader),
    cache.getOrLoad('k', slowLoader),
  ]);
  expect(loads).toBe(1);
  expect(a).toBe(b);
  expect(b).toBe(c);
});

test('loader 抛错不缓存：失败向上传播，下次重试', async () => {
  const cache = new TtlCache<string>(1000, 100);
  let attempts = 0;
  const flaky = async () => {
    attempts++;
    if (attempts === 1) throw new Error('db down');
    return 'ok';
  };
  await expect(cache.getOrLoad('k', flaky)).rejects.toThrow('db down');
  expect(await cache.getOrLoad('k', flaky)).toBe('ok'); // 失败未缓存，第二次真正重载
  expect(attempts).toBe(2);
  expect(await cache.getOrLoad('k', flaky)).toBe('ok'); // 成功后命中
  expect(attempts).toBe(2);
});

test('容量上限：满时按插入序淘汰最旧', () => {
  const cache = new TtlCache<number>(10_000, 3);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  expect(cache.size).toBe(3);
  cache.set('d', 4); // 淘汰最旧的 a
  expect(cache.size).toBe(3);
  expect(cache.get('a')).toBeUndefined();
  expect(cache.get('b')).toBe(2);
  expect(cache.get('d')).toBe(4);
});

test('null/undefined 值可被缓存（miss 语义靠 undefined 约定）', async () => {
  const cache = new TtlCache<string | null>(1000, 100);
  let loads = 0;
  const loader = async () => {
    loads++;
    return null;
  };
  expect(await cache.getOrLoad('miss', loader)).toBeNull(); // null 被缓存
  expect(await cache.getOrLoad('miss', loader)).toBeNull();
  expect(loads).toBe(1);
  expect(cache.size).toBe(1);
});

test('clear 清空全部条目', async () => {
  const cache = new TtlCache<number>(1000, 100);
  await cache.getOrLoad('k', async () => 42);
  expect(cache.size).toBe(1);
  cache.clear();
  expect(cache.size).toBe(0);
  expect(cache.get('k')).toBeUndefined();
});
