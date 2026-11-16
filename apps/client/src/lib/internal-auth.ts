import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * ─────────────────────────────────────────────────────────────
 * 内部 API 面鉴权（/api/internal/* 单一事实源）。
 *
 * 契约：`x-internal-token` 必须等于 INTERNAL_API_TOKEN（sha256 摘要后
 * timingSafeEqual 恒定时间比较）；未配置该 env 时恒 403（默认关闭）；
 * 生产环境拒绝 compose 默认令牌（公开仓库可查，视同未配置）。
 * compose 向 web/admin/worker-go 注入同一令牌值。
 * 消费先例：api/internal/revalidate（admin）、lib/mcp/request-guard
 * （mcp-go 回源）、LLM 网关（worker-go 执行体调用）。
 * ─────────────────────────────────────────────────────────────
 */

/** docker-compose.yml 的 INTERNAL_API_TOKEN 默认值——生产部署必须覆盖 */
export const INSECURE_DEFAULT_TOKEN = 'dev-internal-token-change-me';

export function tokenEquals(received: string | null, expected: string): boolean {
  if (typeof received !== 'string' || received.length === 0) return false;
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(received), digest(expected));
}

/**
 * 内部端点鉴权门：通过返回 null；未通过返回对应 403 响应（调用方直接 return）。
 * 与 revalidate 端点的历史行为逐字一致（抽出为公共模块，M1 LLM 网关复用）。
 */
export function internalAuthGuard(req: NextRequest): NextResponse | null {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: 'internal endpoint disabled' }, { status: 403 });
  }
  if (process.env.NODE_ENV === 'production' && expected === INSECURE_DEFAULT_TOKEN) {
    console.error('[internal-auth] INTERNAL_API_TOKEN is the public compose default — refusing in production');
    return NextResponse.json({ error: 'internal endpoint disabled' }, { status: 403 });
  }
  if (!tokenEquals(req.headers.get('x-internal-token'), expected)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return null;
}
