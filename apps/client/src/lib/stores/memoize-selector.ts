/**
 * 纯函数单槽记忆引擎 (Single-Slot Memoization Engine)
 *
 * 遵循 346 准则：第一性原理 & 零物化模式。
 * 解决 Zustand v5 + React 19 useSyncExternalStore 对 getSnapshot() 严格引用恒定 (Object.is) 的契约约束，
 * 消除因在选择器中重复调用 filter/map/sort 导致的引用漂移与 "Maximum update depth exceeded" 风险。
 */

/**
 * 浅层数组全等比较（逐项 Object.is）
 */
export function shallowArrayEqual<T>(
  a: readonly T[] | null | undefined,
  b: readonly T[] | null | undefined
): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b) return false;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

/**
 * 浅层对象全等比较（键数量与键值逐项 Object.is）
 */
export function shallowObjectEqual<T extends object>(
  a: T | null | undefined,
  b: T | null | undefined
): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) return false;
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const key = keysA[i];
    if (!Object.prototype.hasOwnProperty.call(objB, key) || !Object.is(objA[key], objB[key])) {
      return false;
    }
  }
  return true;
}

/**
 * 通用浅层参数比对
 */
export function defaultArgsEqual<TArgs extends readonly unknown[]>(prev: TArgs, next: TArgs): boolean {
  return shallowArrayEqual(prev, next);
}

export type MemoizedFunction<TArgs extends readonly unknown[], TResult> = ((...args: TArgs) => TResult) & {
  clear: () => void;
};

/**
 * 单槽记忆器：对最后一次入参与结果进行单槽缓存。
 * 当且仅当 isEqual(prevArgs, nextArgs) === true 时，直接返回恒定内存引用的结果。
 */
export function memoizeOne<TArgs extends readonly unknown[], TResult>(
  fn: (...args: TArgs) => TResult,
  isEqual: (prev: TArgs, next: TArgs) => boolean = defaultArgsEqual
): MemoizedFunction<TArgs, TResult> {
  let lastArgs: TArgs | null = null;
  let lastResult: TResult | null = null;
  let hasResult = false;

  const memoized = ((...args: TArgs): TResult => {
    if (hasResult && lastArgs !== null && isEqual(lastArgs, args)) {
      return lastResult as TResult;
    }
    const result = fn(...args);
    lastArgs = args;
    lastResult = result;
    hasResult = true;
    return result;
  }) as MemoizedFunction<TArgs, TResult>;

  memoized.clear = () => {
    lastArgs = null;
    lastResult = null;
    hasResult = false;
  };

  return memoized;
}

/**
 * 创建针对单个 State 输入的 Zustand 记忆化选择器
 */
export function createMemoizedSelector<TState, TResult>(
  selector: (state: TState) => TResult,
  isStateEqual?: (prev: TState, next: TState) => boolean
): MemoizedFunction<[TState], TResult> {
  const isEqual = isStateEqual
    ? (prev: [TState], next: [TState]) => isStateEqual(prev[0], next[0])
    : defaultArgsEqual;
  return memoizeOne((state: TState) => selector(state), isEqual);
}

/**
 * 创建针对单个 State 输入、返回浅层对象（Record）的 Zustand 双端记忆化选择器
 *
 * 解决 React 18/19 useSyncExternalStore 对 getServerSnapshot() 与 getSnapshot() 的引用恒等约束：
 * 1. 输入侧：输入未变（isStateEqual 为 true 或 Object.is 恒等）直接复用缓存引用；
 * 2. 输出侧：即使输入微弱抖动，若派生出的 Object 键值未变（shallowObjectEqual 为 true），
 *    依然返回历史恒等引用，彻底阻断无效重渲染与 "getServerSnapshot should be cached" 报错。
 */
export function createMemoizedObjectSelector<TState, TResult extends object>(
  selector: (state: TState) => TResult,
  isStateEqual?: (prev: TState, next: TState) => boolean
): MemoizedFunction<[TState], TResult> {
  let lastState: TState | null = null;
  let lastResult: TResult | null = null;
  let hasResult = false;

  const memoized = ((state: TState): TResult => {
    if (
      hasResult &&
      lastState !== null &&
      (isStateEqual ? isStateEqual(lastState, state) : Object.is(lastState, state))
    ) {
      return lastResult as TResult;
    }
    const nextResult = selector(state);
    if (hasResult && lastResult !== null && shallowObjectEqual(lastResult, nextResult)) {
      lastState = state;
      return lastResult;
    }
    lastState = state;
    lastResult = nextResult;
    hasResult = true;
    return nextResult;
  }) as MemoizedFunction<[TState], TResult>;

  memoized.clear = () => {
    lastState = null;
    lastResult = null;
    hasResult = false;
  };

  return memoized;
}
