import { z } from 'zod';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { callSidecar } from '@/lib/sidecar-client';
import { ENGINE_CONFIG } from '@/lib/config';
import { defineRoute } from '@/lib/api/server/define-route';
import { assert, assertFound } from '@/lib/api/server/api-guards';
import * as m from '@/paraglide/messages';

/**
 * 账号注销（DELETE /api/account/delete）：
 * - Prisma 关系级联删除（token/遥测/进度/会话等随 User 级联）
 * - 公开教程作为公共资产保留（共享文档 ownerUserId=null 不随账号级联，
 *   继续服务读者；发布后不可自行撤回，违规内容由管理员下架）
 * - 私有书架教程随账号删除（文档 ownerUserId 级联）
 * - Langfuse 观测痕迹擦除（GDPR Right to Erasure；失败静默降级不阻断注销）
 * body: { confirm: "DELETE" }（双重确认）
 */
export const DELETE = defineRoute({
  scope: 'DELETE /api/account/delete',
  auth: 'user',
  rateLimit: {
    limit: 3,
    windowMs: 3600000,
    identifier: ({ userId }) => `account-delete:${userId}`,
  },
  bodySchema: z.object({ confirm: z.string().optional() }),
  handler: async ({ body, userId }) => {
    assert(body.confirm === 'DELETE', 'INVALID_PARAM', 'confirm="DELETE" required');

    const user = assertFound(
      await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } })
    );

    // 同邮箱的 AdminUser 一并失活：AdminUser 与 User 无外键、按邮箱匹配鉴权，
    // 不处理的话被注销的管理员在 JWT 有效期内仍持全量管理权限（审计矩阵 BUG-M08-02）。
    if (user.email) {
      await prisma.adminUser.updateMany({ where: { email: user.email }, data: { isActive: false } });
    }

    await callSidecar('/v1/user/delete', { id: userId }, { label: 'account-delete' });

    // GDPR Right to Erasure：擦除 Langfuse 观测痕迹（原无入口的 /api/purge
    // 路由能力并入注销主流程——2026-11 死路由收敛；失败静默降级，主库级联已生效）
    try {
      const authHeader = 'Basic ' + Buffer.from(
        `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`
      ).toString('base64');
      await fetch(`${ENGINE_CONFIG.endpoints.langfuse}/api/public/users/${userId}`, {
        method: 'DELETE',
        headers: { Authorization: authHeader },
      });
      console.log(`[Privacy] Flushed Langfuse traces for user: ${userId}`);
    } catch (lfError) {
      console.error('[Privacy] Failed to flush Langfuse traces:', lfError);
    }

    // JWT 为无状态会话、服务端无法吊销已签发令牌：主动清除会话 Cookie，
    // 保证注销者浏览器即刻退出登录态（残留 JWT 的深度防御需 token 版本号机制，见附录 B）。
    const response = NextResponse.json({
      success: true,
      message: m.account_deleted_title(),
    });
    for (const cookieName of ['next-auth.session-token', '__Secure-next-auth.session-token']) {
      response.cookies.set(cookieName, '', { path: '/', maxAge: 0 });
    }
    return response;
  },
});
