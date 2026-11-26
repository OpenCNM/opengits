// Dynamic imports inside NEXT_RUNTIME==='nodejs' keep Node-only modules out of Next's Edge bundle.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  if (process.env.SENTRY_DSN) {
    const Sentry = await import('@sentry/nextjs');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV,
      tracesSampleRate: 0,
      sendDefaultPii: false,
    });
    console.log('[instrumentation] error monitoring enabled (SENTRY_DSN)');
  }

  if ((process.env.STORAGE_DRIVER || '').toLowerCase() === 's3') {
    await import('@/lib/storage/driver-s3');
    console.log('[instrumentation] storage driver: s3');
  }

  void import('@/engine/tarball/archive-store')
    .then((m) => m.normalizeLegacyCaseDirs())
    .catch((err) => {
      console.warn('[instrumentation] archive case normalization failed:', err);
    });
}

export async function onRequestError(
  request: { path: string; method: string },
  error: unknown,
  context: { routerKind: string; routePath: string; routeType: string }
): Promise<void> {
  const { captureError } = await import('@/lib/observability/errors');
  await captureError(error, {
    scope: `next/${context.routerKind}`,
    extra: {
      method: request.method,
      path: request.path,
      routePath: context.routePath,
      routeType: context.routeType,
    },
  });
}
