import { z } from 'zod';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { callSidecar } from '@/lib/sidecar-client';
import { ENGINE_CONFIG } from '@/lib/config';
import { defineRoute } from '@/lib/api/server/define-route';
import { assert, assertFound } from '@/lib/api/server/api-guards';
import * as m from '@/paraglide/messages';

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

    if (user.email) {
      await prisma.adminUser.updateMany({ where: { email: user.email }, data: { isActive: false } });
    }

    await callSidecar('/v1/user/delete', { id: userId }, { label: 'account-delete' });

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
