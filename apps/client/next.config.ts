import type { NextConfig } from "next";
import dns from "node:dns";
import path from "node:path";
import dotenv from "dotenv";

// 保证 Monorepo 子应用启动时无论何种方式均能加载根目录 .env 与 .env.local
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local") });
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

// Fix IPv6 DNS resolution hangs with some VPN/TUN network setups
// Node 18+ undici defaults to IPv6 first, which can hang when the tunnel drops AAAA records.
dns.setDefaultResultOrder('ipv4first');

/**
 * 网关安全中心：全站安全响应头。
 * - CSP 默认 Report-Only（观察模式，不阻断现有内联脚本/样式），CSP_ENFORCE=1 切 enforcing；
 *   策略可用 CSP_POLICY env 整体覆盖（指令分号连接）。
 * - HSTS 在 http 明文下被浏览器忽略，经 Caddy TLS 终止后生效。
 */
const DEFAULT_CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

const SECURITY_HEADERS: Array<{ key: string; value: string }> = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=15552000' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: process.env.CSP_ENFORCE === '1' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only',
    value: process.env.CSP_POLICY || DEFAULT_CSP_POLICY,
  },
];

const nextConfig: NextConfig = {
  // 生产环境独立构建：依赖摇树裁剪，镜像体积和运行时常驻内存从 ~500MB+ 压减至 ~150-250MB
  output: 'standalone',
  // 控制服务端运行时默认内存缓存上限（25MB），防止页面/路由响应在长期运行时导致内存无节制膨胀
  cacheMaxMemorySize: 25 * 1024 * 1024,
  productionBrowserSourceMaps: false,
  // 零 WASM 架构：代码符号与图谱构建全量下沉 Go worker-sidecar，消灭 tree-sitter wasm 运行时。
  serverExternalPackages: ['shiki', 'undici', 'ai', '@ai-sdk/openai', '@ai-sdk/openai-compatible', '@ai-sdk/provider', '@ai-sdk/provider-utils'],
  poweredByHeader: false,
  // 细粒度包导入摇树，减少重型前端包解析图谱对 Node 内存的占用
  experimental: {
    optimizePackageImports: ['lucide-react', 'framer-motion', '@base-ui/react'],
    webpackMemoryOptimizations: true,
  },
  // Extra LAN origins (beyond localhost) can be allow-listed for dev via ALLOWED_DEV_ORIGINS="http://host:port,..."
  allowedDevOrigins: [
    'localhost',
    '127.0.0.1', // lint-ignore: IP-001
    ...(process.env.ALLOWED_DEV_ORIGINS ? process.env.ALLOWED_DEV_ORIGINS.split(',').map(s => s.trim()) : []),
  ],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin",
          },
          // ── 网关安全中心：全站安全响应头（取代 proxy.ts 内逐响应设置，单一事实源）──
          ...SECURITY_HEADERS,
        ],
      },
    ];
  },
  async rewrites() {
    // 独立应用解耦：将 /admin 流量代理至独立运行的 Admin 控制台服务 (3999)
    const adminUrl = process.env.ADMIN_INTERNAL_URL || 'http://localhost:3999';
    return [
      {
        source: '/admin',
        destination: `${adminUrl}/admin`,
      },
      {
        source: '/admin/:path*',
        destination: `${adminUrl}/admin/:path*`,
      },
      {
        source: '/api/admin/:path*',
        destination: `${adminUrl}/admin/api/admin/:path*`,
      },
    ];
  },
};

export default nextConfig;
