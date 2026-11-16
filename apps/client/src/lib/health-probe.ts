/**
 * ─────────────────────────────────────────────────────────────
 * 健康探针共享超时工具与防护
 *
 * 规范：
 * - withTimeout(promise, ms, fallback)
 * - 默认 3000ms 超时
 * - 超时/失败返回 fallback（如定义），或抛出超时错误
 * ─────────────────────────────────────────────────────────────
 */

export async function withTimeout<T>(
  promise: Promise<T> | (() => Promise<T>),
  ms: number = 3000,
  fallback?: T
): Promise<T> {
  const p = typeof promise === 'function' ? promise() : promise;
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Operation timed out after ${ms}ms`));
    }, ms);
  });

  try {
    const result = await Promise.race([p, timeoutPromise]);
    return result;
  } catch (err) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
