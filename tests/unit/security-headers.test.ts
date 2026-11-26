import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * 全站安全响应头与渐进式 CSP 策略单测（Unit 11.6）
 * 契约（向量 11.6.1.1）：
 * - 🧪 [11.6.1.1] 默认 Report-Only，防止直接 enforcing 打断现有内联脚本与样式；
 *   CSP_ENFORCE=1 升级为 enforcing；CSP_POLICY env 允许整体自定义覆盖；
 *   必须包含 nosniff, SAMEORIGIN, HSTS 等基线安全响应头。
 */

describe('全站安全响应头与渐进式 CSP (Unit 11.6)', () => {
  const origCspEnforce = process.env.CSP_ENFORCE;
  const origCspPolicy = process.env.CSP_POLICY;

  beforeEach(() => {
    delete process.env.CSP_ENFORCE;
    delete process.env.CSP_POLICY;
    vi.resetModules();
  });

  afterEach(() => {
    if (origCspEnforce !== undefined) process.env.CSP_ENFORCE = origCspEnforce;
    else delete process.env.CSP_ENFORCE;

    if (origCspPolicy !== undefined) process.env.CSP_POLICY = origCspPolicy;
    else delete process.env.CSP_POLICY;

    vi.resetModules();
  });

  it('🧪 [11.6.1.1] 客户端 next.config 默认输出 Content-Security-Policy-Report-Only 与基线安全头', async () => {
    const clientConfig = (await import('../../apps/client/next.config')).default;
    const headerRules = await clientConfig.headers?.();
    expect(headerRules).toBeDefined();

    const rootRule = headerRules?.find((r) => r.source === '/:path*');
    expect(rootRule).toBeDefined();

    const headersMap = new Map(rootRule!.headers.map((h) => [h.key, h.value]));
    expect(headersMap.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headersMap.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(headersMap.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headersMap.get('Strict-Transport-Security')).toBe('max-age=15552000');
    expect(headersMap.get('Permissions-Policy')).toContain('camera=()');

    // 默认是 Report-Only 观察模式
    expect(headersMap.has('Content-Security-Policy-Report-Only')).toBe(true);
    expect(headersMap.has('Content-Security-Policy')).toBe(false);
    expect(headersMap.get('Content-Security-Policy-Report-Only')).toContain("default-src 'self'");
  });

  it('🧪 [11.6.1.1] CSP_ENFORCE=1 时平滑升级为 enforcing Content-Security-Policy', async () => {
    process.env.CSP_ENFORCE = '1';
    vi.resetModules();

    const clientConfig = (await import('../../apps/client/next.config')).default;
    const headerRules = await clientConfig.headers?.();
    const rootRule = headerRules?.find((r) => r.source === '/:path*');
    const headersMap = new Map(rootRule!.headers.map((h) => [h.key, h.value]));

    expect(headersMap.has('Content-Security-Policy')).toBe(true);
    expect(headersMap.has('Content-Security-Policy-Report-Only')).toBe(false);
  });

  it('🧪 [11.6.1.1] CSP_POLICY 环境变量允许对策略进行整体覆盖', async () => {
    process.env.CSP_POLICY = "default-src 'self'; script-src 'self' https://trusted.cdn.com";
    vi.resetModules();

    const clientConfig = (await import('../../apps/client/next.config')).default;
    const headerRules = await clientConfig.headers?.();
    const rootRule = headerRules?.find((r) => r.source === '/:path*');
    const headersMap = new Map(rootRule!.headers.map((h) => [h.key, h.value]));

    expect(headersMap.get('Content-Security-Policy-Report-Only')).toBe(
      "default-src 'self'; script-src 'self' https://trusted.cdn.com"
    );
  });

  // 🧪 [11.6.1.1] 管理端 next.config 安全头契约随 admin 拆分迁至私有仓
  // tests/unit/security-headers.admin.test.ts
});
