/**
 * 公开 API 路径前缀与精准匹配白名单（集中收敛，防魔法字符串）。
 *
 * 供 Edge 运行时网关（apps/client/src/proxy.ts）消费。
 * 契约：凡在本白名单前缀下的路由，必须自行完成鉴权与限流
 * （defineRoute 的 auth/rateLimit spec，或 HMAC/internal-token 等自鉴权），
 * 网关层对它们只保留 WAF / IP 黑名单 / 匿名 RPM 三道公共防线。
 * 注意：本文件必须保持纯粹（无 Node-only API、无数据库 client），
 * 以确保完全兼容 Next.js Edge Runtime。
 */

/**
 * 前缀匹配的公开 API 路径（一律带尾部斜杠，防止 `/api/xxx` 误吞 `/api/xxxY` 兄弟前缀）
 */
export const PUBLIC_API_PREFIXES = [
  '/api/auth/', // NextAuth 会话与 OAuth 回调（CSRF 由 NextAuth 自防护）
  '/api/webhooks/', // GitHub webhook：HMAC 签名自鉴权
  '/api/internal/', // 内部跨容器微服务调用：x-internal-token 自鉴权
  '/api/mcp/', // MCP 协议子路径自鉴权 (Bearer Token)；本体见精确表
  '/api/docs-content/', // 公开阅读内容 (SECURITY.md 白名单)
  '/api/assets/', // 仓库公开静态资源 (SECURITY.md 白名单)
  '/api/versions/', // 仓库版本与讲法列表
  '/api/repos/', // 仓库匿名元数据与阅读量打点（/view 由服务端 IP/用户 窗口去重）
  '/api/update/jobs/', // 活跃更新任务浏览与 worker 认领端点（子路径路由内 auth:'user' 兜底）
  '/api/llms-txt/', // llms.txt 导览端点 (SECURITY.md 白名单)
  '/api/ingest-status/', // 转录状态查询（由 defineRoute 自鉴权：公开仓匿名可查，私有仓鉴权）
  '/api/ingest/', // 转录事件与操作端点（/events, /pause 等由各路由自行鉴权）
  '/api/documents/', // 文档状态与操作端点（由 defineRoute 自行鉴权）
  '/api/chapter-versions/', // 章节版本列表与投票（由 defineRoute 自行鉴权）
] as const;

/**
 * 精确匹配的公开 API 路径
 */
export const PUBLIC_API_EXACT = [
  '/api/health', // 容器存活探针
  '/api/user/credits', // 用户每日配额（未登录返回默认配额视图，不阻断）
  '/api/mcp', // MCP 协议端点本体（Bearer Token 自鉴权）
  '/api/ai/providers', // 动态模型服务商列表（公开目录）
  '/api/update/jobs', // 活跃更新任务列表（公开浏览）
  '/api/repositories/reading-progress/sync', // 阅读进度同步（匿名返回空结构）
] as const;

/**
 * MCP 协议路径精确判定：`/api/mcp` 本体 + `/api/mcp/**` 子路径。
 * 供 proxy.ts 的机器流量豁免消费——绝不匹配 `/api/mcpX` 兄弟前缀。
 */
export function isMcpProtocolPath(pathname: string): boolean {
  return pathname === '/api/mcp' || pathname.startsWith('/api/mcp/');
}

/**
 * 校验给定 API 路径是否属于公开端点（免 proxy.ts 的 JWT 强制拦截）
 */
export function isPublicApiPath(pathname: string): boolean {
  for (const exact of PUBLIC_API_EXACT) {
    if (pathname === exact) return true;
  }
  for (const prefix of PUBLIC_API_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  return false;
}
