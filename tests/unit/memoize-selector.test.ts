import { describe, expect, it, vi } from 'vitest';
import {
  memoizeOne,
  createMemoizedSelector,
  createMemoizedObjectSelector,
  shallowArrayEqual,
  shallowObjectEqual,
} from '@/lib/stores/memoize-selector';

describe('memoize-selector 单槽记忆引擎 (First-Principles Resilience)', () => {
  describe('shallowArrayEqual', () => {
    it('相同引用或两端为 null/undefined 返回正确结果', () => {
      const arr = [1, 2, 3];
      expect(shallowArrayEqual(arr, arr)).toBe(true);
      expect(shallowArrayEqual(null, null)).toBe(true);
      expect(shallowArrayEqual(undefined, undefined)).toBe(true);
      expect(shallowArrayEqual(arr, null)).toBe(false);
      expect(shallowArrayEqual(null, arr)).toBe(false);
    });

    it('长度不同判定为不相等', () => {
      expect(shallowArrayEqual([1, 2], [1, 2, 3])).toBe(false);
    });

    it('元素浅层全等返回 true，任一元素不同返回 false', () => {
      const obj = { id: 'x' };
      expect(shallowArrayEqual(['a', 'b', obj], ['a', 'b', obj])).toBe(true);
      expect(shallowArrayEqual(['a', 'b', obj], ['a', 'b', { id: 'x' }])).toBe(false);
    });

    it('非数组类型判定为不相等', () => {
      expect(shallowArrayEqual({ length: 0 } as any, { length: 0 } as any)).toBe(false);
      expect(shallowArrayEqual([1] as any, '1' as any)).toBe(false);
    });
  });

  describe('shallowObjectEqual', () => {
    it('相同引用与空值判定', () => {
      const obj = { a: 1, b: '2' };
      expect(shallowObjectEqual(obj, obj)).toBe(true);
      expect(shallowObjectEqual(null, null)).toBe(true);
      expect(shallowObjectEqual(obj, null)).toBe(false);
    });

    it('非对象（数字、布尔值等基本类型）或数组判定为不相等', () => {
      expect(shallowObjectEqual(123 as any, 456 as any)).toBe(false);
      expect(shallowObjectEqual(true as any, false as any)).toBe(false);
      expect(shallowObjectEqual([1] as any, [1] as any)).toBe(false);
      expect(shallowObjectEqual('abc' as any, 'def' as any)).toBe(false);
    });

    it('键数量或键名不一致判定为 false', () => {
      expect(shallowObjectEqual({ a: 1 }, { a: 1, b: 2 } as any)).toBe(false);
      expect(shallowObjectEqual({ a: 1, c: 2 } as any, { a: 1, b: 2 } as any)).toBe(false);
    });

    it('值浅层全等返回 true，不同返回 false', () => {
      const inner = [1, 2];
      expect(shallowObjectEqual({ a: 1, b: inner }, { a: 1, b: inner })).toBe(true);
      expect(shallowObjectEqual({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toBe(false);
    });
  });

  describe('memoizeOne', () => {
    it('输入参数浅层全等时，返回绝对恒定的内存引用 (Object.is === true)', () => {
      const spy = vi.fn((a: number, b: string) => ({ sum: `${a}-${b}` }));
      const memoized = memoizeOne(spy);

      const r1 = memoized(1, 'apple');
      const r2 = memoized(1, 'apple');

      expect(spy).toHaveBeenCalledTimes(1);
      expect(r1).toBe(r2); // 绝对恒等引用
    });

    it('任一输入参数发生物理变化时，重新计算并更新单槽缓存', () => {
      const spy = vi.fn((a: number, b: string) => ({ sum: `${a}-${b}` }));
      const memoized = memoizeOne(spy);

      const r1 = memoized(1, 'apple');
      const r2 = memoized(2, 'apple');
      const r3 = memoized(2, 'apple');

      expect(spy).toHaveBeenCalledTimes(2);
      expect(r1).not.toBe(r2);
      expect(r2).toBe(r3);
    });

    it('支持自定义相等性判定函数', () => {
      interface ComplexArg {
        id: string;
        timestamp: number;
      }
      const spy = vi.fn((arg: ComplexArg) => ({ processedId: arg.id }));
      // 仅根据 id 进行缓存判定，忽略 timestamp 变化
      const memoized = memoizeOne(spy, (prev, next) => prev[0].id === next[0].id);

      const r1 = memoized({ id: 'doc-1', timestamp: 100 });
      const r2 = memoized({ id: 'doc-1', timestamp: 200 });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(r1).toBe(r2);

      const r3 = memoized({ id: 'doc-2', timestamp: 300 });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(r3).not.toBe(r1);
    });

    it('clear() 能够重置单槽缓存，强制下次调用重新执行', () => {
      const spy = vi.fn((x: number) => ({ value: x * 2 }));
      const memoized = memoizeOne(spy);

      const r1 = memoized(5);
      const r2 = memoized(5);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(r1).toBe(r2);

      memoized.clear();

      const r3 = memoized(5);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(r3).toEqual(r1);
      expect(r3).not.toBe(r1); // 重新计算产生的新引用
    });
  });

  describe('createMemoizedSelector & 连续高频变动稳定性', () => {
    interface StoreState {
      documents: Array<{ id: string; status: string }>;
      activeId: string | null;
      unrelatedCounter: number;
    }

    it('在无关状态变动时返回恒定引用，杜绝 React 19 useSyncExternalStore 循环重渲染', () => {
      const computeProjection = (state: StoreState) => {
        return {
          total: state.documents.length,
          active: state.documents.find((d) => d.id === state.activeId) ?? null,
          processed: state.documents.filter((d) => d.status === 'DONE').length,
        };
      };

      const selector = createMemoizedSelector(
        computeProjection,
        (prev, next) =>
          prev.documents === next.documents && prev.activeId === next.activeId
      );

      const sharedDocs = [{ id: '1', status: 'DONE' }, { id: '2', status: 'PENDING' }];

      let state: StoreState = {
        documents: sharedDocs,
        activeId: '1',
        unrelatedCounter: 0,
      };

      const initialResult = selector(state);

      // 模拟 100 次由于计时器/遥测等无关字段引发的 store state 变动
      for (let i = 1; i <= 100; i++) {
        state = {
          ...state,
          unrelatedCounter: i,
        };
        const currentResult = selector(state);
        expect(currentResult).toBe(initialResult);
      }

      // 当核心字段 documents 真正发生变更时，生成新引用
      state = {
        ...state,
        documents: [...sharedDocs, { id: '3', status: 'PENDING' }],
      };
      const nextResult = selector(state);
      expect(nextResult).not.toBe(initialResult);
      expect(nextResult.total).toBe(3);

      // 再次以相同核心状态调用，维持新引用恒定
      const nextResult2 = selector(state);
      expect(nextResult2).toBe(nextResult);
    });
  });

  describe('createMemoizedObjectSelector (Dual-Ended Object Memoization for React 18/19 SSR)', () => {
    interface TestStore {
      step: number;
      loading: boolean;
      counter: number;
    }

    it('连续调用相同 state 时返回绝对恒等引用 (解决 getServerSnapshot 引用抖动)', () => {
      const state: TestStore = { step: 1, loading: false, counter: 0 };
      const selector = createMemoizedObjectSelector((s: TestStore) => ({
        status: s.loading ? 'loading' : 'ready',
        step: s.step,
      }));

      const r1 = selector(state);
      const r2 = selector(state);
      expect(r1).toBe(r2); // 绝对恒等引用，彻底满足 React getServerSnapshot 契约
    });

    it('无相关状态变动导致 state 引用变化，若输出字段浅层相等依然返回旧引用 (输出端浅比较防御)', () => {
      const s1: TestStore = { step: 1, loading: false, counter: 0 };
      const s2: TestStore = { step: 1, loading: false, counter: 1 }; // counter 变了，但输出不变

      const selector = createMemoizedObjectSelector((s: TestStore) => ({
        status: s.loading ? 'loading' : 'ready',
        step: s.step,
      }));

      const r1 = selector(s1);
      const r2 = selector(s2);
      expect(r1).toBe(r2); // 阻断下游无效重渲染
    });

    it('输出内容真正改变时，生成新引用并保持后续恒等', () => {
      const s1: TestStore = { step: 1, loading: false, counter: 0 };
      const s2: TestStore = { step: 2, loading: false, counter: 0 };

      const selector = createMemoizedObjectSelector((s: TestStore) => ({
        status: s.loading ? 'loading' : 'ready',
        step: s.step,
      }));

      const r1 = selector(s1);
      const r2 = selector(s2);
      expect(r1).not.toBe(r2);
      expect(r2.step).toBe(2);

      const r3 = selector(s2);
      expect(r3).toBe(r2);
    });
  });
});
