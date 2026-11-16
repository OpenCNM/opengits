/**
 * 穷尽性守卫（Exhaustiveness Guard）。
 *
 * 用法：对判别联合（Discriminated Union）的消费 switch，把兜底分支写为
 * `default: return assertNever(value, '消费点名称')`。此后状态机新增任何状态值，
 * 未显式处理的消费点将在此处产生**编译错误**（never 不可赋值），
 * 而不是静默落入 else 走错分支——「让非法状态不可表示」的运行时边界。
 */
export function assertNever(value: never, context?: string): never {
  const rendered =
    value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
  throw new Error(
    `Unhandled discriminated state: ${rendered}${context ? ` (in ${context})` : ''}`
  );
}
