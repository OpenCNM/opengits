/**
 * Prisma 深度代理 mock：单测统一入口。
 *
 * 用法：
 *   vi.mock('@/lib/db', () => ({ prisma: mockPrisma({ user: { findUnique: async () => fakeUser } }) }));
 *
 * 未覆写的方法返回可链式调用的 thenable 代理——await 解析为 undefined、
 * 继续取属性/调用不抛错，让被测代码顺利走到断言关注的分支。
 */
type Fn = (...args: unknown[]) => unknown;

function chainable(): any {
  return new Proxy(function () {} as any, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v?: unknown) => void) => resolve(undefined);
      if (prop === 'catch') return () => Promise.resolve(undefined);
      return chainable();
    },
    apply: () => chainable(),
  });
}

export function mockPrisma(overrides: Record<string, Record<string, Fn>> = {}): any {
  const proxy: any = new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (prop === '$transaction') {
        return async (fnOrArray: unknown) => {
          // 数组形态：逐个 await；函数形态：以同一 mock 作为 tx 传入
          if (Array.isArray(fnOrArray)) return Promise.all(fnOrArray);
          return (fnOrArray as (tx: any) => unknown)(proxy);
        };
      }
      return chainable();
    },
  });
  return proxy;
}
