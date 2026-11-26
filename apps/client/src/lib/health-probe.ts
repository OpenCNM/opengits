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
