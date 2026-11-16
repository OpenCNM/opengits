import { DEFAULT_PLATFORM_URL } from '@/lib/constants';

/**
 * 安全获取当前客户端应用 Origin (基准域与协议端口)
 * 遵循反硬编码规范：绝不在客户端或服务端直接硬编码 localhost:3000
 */
export function getClientOrigin(fallback: string = ''): string {
  if (typeof window !== 'undefined' && window.location.origin) {
    return window.location.origin;
  }
  return process.env.NEXT_PUBLIC_APP_URL || fallback;
}

/**
 * 安全获取全站绝对基准 URL (支持 Vercel 部署域名、自定义 APP_URL 与环境优先推导)
 * 用于 Sitemap、Robots、RSS 等元数据路由的绝对路径输出
 */
export function getBaseUrl(fallback: string = DEFAULT_PLATFORM_URL): string {
  const url =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : fallback);
  return url.replace(/\/+$/, '');
}
