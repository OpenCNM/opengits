// 统一错误采集器（client / admin / worker 三端共用，经各自的 `@/*` 路径别名）。
//
// 语义：始终输出结构化本地日志（容器日志可采集）；SENTRY_DSN 已配置时
// 追加 Sentry 协议上报（指向自托管 GlitchTip 或 Sentry 均可）。
// 铁律：上报器自身永不抛错、永不阻塞——监控故障绝不能影响业务路径。
// 仅限服务端代码使用（lib/调度器/API 路由）；浏览器侧上报走 telemetry beacon。

export interface ErrorContext {
  /** 子系统标签，如 'update-market/postSwap' */
  scope: string;
  /** 附加上下文（数值/字符串/可 JSON 化对象） */
  extra?: Record<string, unknown>;
}

type SentryLike = {
  captureException: (error: unknown, hint?: { extra?: Record<string, unknown>; tags?: Record<string, string> }) => void;
  captureMessage: (message: string, level?: 'warning' | 'error' | 'info') => void;
};

let sentryPromise: Promise<SentryLike | null> | null = null;

function resolveDsn(): string | undefined {
  const dsn = process.env.SENTRY_DSN?.trim();
  // 占位值（example/留空）视为未配置 → 纯本地日志
  return dsn && dsn.startsWith('http') && !dsn.includes('example') ? dsn : undefined;
}

/** 惰性加载 Sentry（未配置 DSN 或 SDK 不可用 → null，仅本地日志） */
function getSentry(): Promise<SentryLike | null> {
  if (!resolveDsn()) return Promise.resolve(null);
  if (!sentryPromise) {
    sentryPromise = import('@sentry/node')
      .then((sdk) => sdk as unknown as SentryLike)
      .catch(() => null);
  }
  return sentryPromise;
}

function formatContext(ctx?: ErrorContext): string {
  if (!ctx?.extra || Object.keys(ctx.extra).length === 0) return '';
  try {
    return ` ${JSON.stringify(ctx.extra)}`;
  } catch {
    return ' [extra 不可序列化]';
  }
}

/** 采集异常：本地结构化日志 + 可选远端上报；返回 Promise 仅用于进程退出前的 flush 场景 */
export async function captureError(error: unknown, ctx: ErrorContext): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? `\n${error.stack ?? ''}` : '';
  console.error(`[${ctx.scope}] ${message}${formatContext(ctx)}${stack}`);
  try {
    const sentry = await getSentry();
    sentry?.captureException(error, {
      tags: { scope: ctx.scope },
      extra: ctx.extra,
    });
  } catch {
    // 永不抛错
  }
}

/** 采集告警级消息（非异常的异常状况，如 redis 限流降级） */
export async function captureWarn(message: string, ctx?: ErrorContext): Promise<void> {
  const scope = ctx?.scope ?? 'app';
  console.warn(`[${scope}] ${message}${formatContext(ctx)}`);
  try {
    const sentry = await getSentry();
    sentry?.captureMessage(`[${scope}] ${message}`, 'warning');
  } catch {
    // 永不抛错
  }
}
