import { NextRequest } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';
import { getSessionHelper } from '@/lib/auth-helper';
import { prisma } from '@/lib/db';
import { callSidecar } from '@/lib/sidecar-client';
import { TtlCache } from '@/lib/cache/ttl-cache';

/**
 * ─────────────────────────────────────────────────────────────
 * MCP 端点统一鉴权（Bearer API Token + Web 会话 Cookie 双通道）
 *
 * 背景：主流编程智能体客户端（Cursor / Claude Code / Codex CLI /
 * Windsurf）以独立 HTTP 客户端身份连接远程 MCP Server，无法携带
 * Web 浏览器会话 Cookie，只接受 OAuth 或自定义请求头中的凭证。
 * 本项目采用与 GitHub PAT 同习惯的「每用户 API Token」方案：
 *   Authorization: Bearer opgts_xxxxxxxx...
 *
 * 优先级：Token 优先于 Cookie（无状态智能体通道），且携带无效
 * Token 时直接拒绝、不回落到 Cookie——避免身份串号。
 * ─────────────────────────────────────────────────────────────
 */

export interface McpAuthResult {
  /** 鉴权所得用户 ID（未通过时为 null） */
  userId: string | null;
  /** 鉴权通道：'token'（API Token）/ 'cookie'（Web 会话） */
  via: 'token' | 'cookie' | null;
}

/** 生成新 API Token 明文（opgts_ + 32 位十六进制，一次性展示） */
export function generateApiToken(): string {
  return `opgts_${randomBytes(16).toString('hex')}`;
}

/** Token 明文 → sha256 摘要（数据库只存摘要，泄露库不泄露 Token） */
export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 从 Authorization 头或 URL Query 提取 Bearer Token（无则返回 null） */
function extractBearerToken(request: NextRequest): string | null {
  const authHeader = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (match && match[1]?.trim()) {
    return match[1].trim();
  }
  // 兼容 Antigravity / SSE 客户端通过 URL query 参数传 Token (如 ?token=opgts_... 或 ?apiKey=opgts_...)
  const tokenQuery = request.nextUrl?.searchParams?.get('token') || request.nextUrl?.searchParams?.get('apiKey');
  if (tokenQuery?.trim()) {
    return tokenQuery.trim();
  }
  return null;
}

// ── Token/角色 60s 读缓存（性能：原每请求两次无缓存 DB 查询）──
// 边缘（Go sidecar）已有 5min tokenCache 把关吊销，Node 侧缓存不扩大
// 实效吊销窗口的上界；负缓存 10s 防扫描型 miss 击穿（对齐 Go 侧口径）。
// 采用有上限带清扫的 TtlCache，防止随机 token 轰炸导致内存泄露 DoS。
interface TokenCacheEntry {
  userId: string;
  tokenId: string;
}

const TOKEN_CACHE_TTL_MS = 60 * 1000;
const TOKEN_CACHE_NEG_TTL_MS = 10 * 1000;
const TOKEN_CACHE_MAX_ENTRIES = 5000;

const tokenCache = new TtlCache<TokenCacheEntry | null>(TOKEN_CACHE_TTL_MS, TOKEN_CACHE_MAX_ENTRIES);

// token touch 60s 节流：lastUsedAt 展示精度为分钟级，无需每请求打一次 sidecar HTTP
const TOKEN_TOUCH_INTERVAL_MS = 60 * 1000;
const tokenTouchThrottle = new TtlCache<number>(TOKEN_TOUCH_INTERVAL_MS, TOKEN_CACHE_MAX_ENTRIES);

const roleCache = new TtlCache<string>(TOKEN_CACHE_TTL_MS, TOKEN_CACHE_MAX_ENTRIES);

/** 从数据库解析用户角色（Token 通道无 session 角色信息；查不到视为 USER；60s 缓存） */
export async function getRoleForMcpUser(userId: string): Promise<string> {
  const hit = roleCache.get(userId);
  if (hit) return hit;
  const user = await prisma.user
    .findUnique({ where: { id: userId }, select: { role: true } })
    .catch(() => null);
  const role = user?.role || 'USER';
  roleCache.set(userId, role);
  return role;
}

function touchTokenLastUsedThrottled(tokenId: string) {
  if (tokenTouchThrottle.has(tokenId)) return;
  tokenTouchThrottle.set(tokenId, Date.now());
  // 非阻塞更新最后使用时间（下沉 Go worker-sidecar 单一写者，失败不阻断调用）
  void callSidecar('/v1/mcp/tokens/touch', { id: tokenId }, { label: 'mcp-token-touch' }).catch(() => undefined);
}

/**
 * MCP 端点统一鉴权：优先 Bearer API Token，其次 Web 会话 Cookie。
 * 返回 { userId, via }；未鉴权成功时 userId 为 null。
 */
export async function authenticateMcpRequest(request: NextRequest): Promise<McpAuthResult> {
  const bearerToken = extractBearerToken(request);

  if (bearerToken) {
    const tokenHash = hashApiToken(bearerToken);
    const cached = tokenCache.get(tokenHash);
    if (cached !== undefined) {
      if (cached) {
        touchTokenLastUsedThrottled(cached.tokenId);
        return { userId: cached.userId, via: 'token' };
      }
      return { userId: null, via: 'token' };
    }

    const record = await prisma.mcpApiToken
      .findFirst({
        where: { tokenHash, revokedAt: null },
        select: { id: true, userId: true },
      })
      .catch(() => null);

    if (record) {
      tokenCache.set(tokenHash, { userId: record.userId, tokenId: record.id }, TOKEN_CACHE_TTL_MS);
      touchTokenLastUsedThrottled(record.id);
      return { userId: record.userId, via: 'token' };
    }
    tokenCache.set(tokenHash, null, TOKEN_CACHE_NEG_TTL_MS);
    // 携带了无效/已吊销 Token：直接拒绝，绝不回落 Cookie 造成身份串号
    return { userId: null, via: 'token' };
  }

  const session = await getSessionHelper();
  if (session?.user?.id) {
    return { userId: session.user.id, via: 'cookie' };
  }
  return { userId: null, via: null };
}
