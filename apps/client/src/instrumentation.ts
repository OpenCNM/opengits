/**
 * Next.js 启动钩子（instrumentation）。
 * - 错误监控初始化（最前）：SENTRY_DSN 已配置时初始化 Sentry 协议上报
 *   （自托管 GlitchTip / Sentry 均可），并导出 onRequestError 钩子采集
 *   API 路由未捕获异常；未配置时零成本跳过。
 * - ImportJob 调度：任务超时回收与后台定时调度 100% 由 Go worker-sidecar
 *   独占（Node in-process 执行器双轨已于 2026-10 收口退役）。
 *
 * 注意：本文件禁止顶层静态 import 任何 Node-only 模块——Next 会把
 * instrumentation 编译出 Edge 变体（middleware/proxy 链），静态 import 会把
 * config.ts（模块顶层 process.cwd()）拖进 Edge 图，每次编译都刷
 * "Node.js API is not supported in the Edge Runtime" 警告。
 * 所有依赖在 NEXT_RUNTIME==='nodejs' 守卫内动态 import。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // 错误监控初始化（先于一切子系统，之后的启动异常才可被上报）
  if (process.env.SENTRY_DSN) {
    const Sentry = await import('@sentry/nextjs');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV,
      // 只采集错误不做性能追踪（自托管后端保持轻量）
      tracesSampleRate: 0,
      sendDefaultPii: false,
    });
    console.log('[instrumentation] error monitoring enabled (SENTRY_DSN)');
  }

  // 对象存储驱动注册（STORAGE_DRIVER=s3 时生效；未配置零成本）
  if ((process.env.STORAGE_DRIVER || '').toLowerCase() === 's3') {
    await import('@/lib/storage/driver-s3');
    console.log('[instrumentation] storage driver: s3');
  }

  // 归档缓存小写归一（一次性迁移清扫，幂等）：历史混合大小写目录在
  // archiveDirFor/archiveKey 小写口径下永不命中——启动即原地重命名/回收，
  // 与 Go sidecar 侧 startupOnce 清扫同语义（共享卷时任一侧先完成即收敛）。
  // 非阻塞：缓存卫生任务不延缓服务就绪，失败仅留控制台痕迹
  void import('@/engine/tarball/archive-store')
    .then((m) => m.normalizeLegacyCaseDirs())
    .catch((err) => {
      console.warn('[instrumentation] archive case normalization failed:', err);
    });

  // ImportJob 执行权：100% Go worker-sidecar（2026-10 收口：Node in-process
  // 执行器双轨已退役，WORKER_INPROCESS 开关随之消亡）。入队即时性由
  // /v1/jobs/enqueue-pump 唤醒端点 + 3s tick 兜底承载。
}

/**
 * Next.js 运行时错误钩子：API/SSR 未捕获异常自动上报（SENTRY_DSN 未配置时零成本）。
 * 签名对齐 Next 16 instrumentation 协议。
 */
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
