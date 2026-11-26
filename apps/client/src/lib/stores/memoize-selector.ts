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

export function defaultArgsEqual<TArgs extends readonly unknown[]>(prev: TArgs, next: TArgs): boolean {
  return shallowArrayEqual(prev, next);
}

export type MemoizedFunction<TArgs extends readonly unknown[], TResult> = ((...args: TArgs) => TResult) & {
  clear: () => void;
};

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

export function createMemoizedSelector<TState, TResult>(
  selector: (state: TState) => TResult,
  isStateEqual?: (prev: TState, next: TState) => boolean
): MemoizedFunction<[TState], TResult> {
  const isEqual = isStateEqual
    ? (prev: [TState], next: [TState]) => isStateEqual(prev[0], next[0])
    : defaultArgsEqual;
  return memoizeOne((state: TState) => selector(state), isEqual);
}

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
