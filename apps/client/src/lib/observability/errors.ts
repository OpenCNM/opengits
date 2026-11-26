import { ignoreBestEffort } from '@/lib/best-effort';

export interface ErrorContext {
  scope: string;
  extra?: Record<string, unknown>;
}

type SentryLike = {
  captureException: (error: unknown, hint?: { extra?: Record<string, unknown>; tags?: Record<string, string> }) => void;
  captureMessage: (message: string, level?: 'warning' | 'error' | 'info') => void;
};

let sentryPromise: Promise<SentryLike | null> | null = null;

function resolveDsn(): string | undefined {
  const dsn = process.env.SENTRY_DSN?.trim();
  return dsn && dsn.startsWith('http') && !dsn.includes('example') ? dsn : undefined;
}

function getSentry(): Promise<SentryLike | null> {
  if (!resolveDsn()) return Promise.resolve(null);
  if (!sentryPromise) {
    sentryPromise = import('@sentry/node')
      .then((sdk) => sdk as unknown as SentryLike)
      .catch(() => {
        ignoreBestEffort();
        return null;
      });
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
    ignoreBestEffort();
  }
}

export async function captureWarn(message: string, ctx?: ErrorContext): Promise<void> {
  const scope = ctx?.scope ?? 'app';
  console.warn(`[${scope}] ${message}${formatContext(ctx)}`);
  try {
    const sentry = await getSentry();
    sentry?.captureMessage(`[${scope}] ${message}`, 'warning');
  } catch {
    ignoreBestEffort();
  }
}
