import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { checkRateLimit } from '@/lib/rate-limit';
import { oauthClientRegisterSchema } from '@/lib/schemas/oauth';

/**
 * RFC 7591 动态客户端注册（DCR 持久化版）。
 * 客户端预注册 client_name 与 redirect_uris 白名单并持久化到 OAuthClient 表，
 * 授权端点严格校验 client_id 存在性与 redirect_uri 白名单。
 * 注册端点开放匿名访问：按 IP 频控，防无界建行填充数据库（审计矩阵 BUG-M08-03）。
 */
export async function POST(req: NextRequest) {
  try {
    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'anonymous';
    if (!(await checkRateLimit(`oauth-register:${clientIp}`, 10, 3_600_000))) {
      return NextResponse.json(
        { error: 'invalid_client_metadata', error_description: 'Too many registrations, retry later' },
        { status: 429 }
      );
    }

    const rawBody = await req.json().catch(() => ({}));
    // 兼容字符串或数组形态，缺失时不默认填补（必须显式提供合规 redirect_uris）
    const redirectUrisInput = Array.isArray(rawBody.redirect_uris)
      ? rawBody.redirect_uris
      : typeof rawBody.redirect_uris === 'string'
        ? [rawBody.redirect_uris]
        : rawBody.redirect_uris;

    const parsed = oauthClientRegisterSchema.safeParse({
      client_name: rawBody.client_name || 'mcp-client',
      redirect_uris: redirectUrisInput,
    });

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'invalid_client_metadata',
          error_description: parsed.error.issues.map((i) => i.message).join('; '),
        },
        { status: 400 }
      );
    }

    const clientId = `opgts-client-${randomBytes(12).toString('hex')}`;

    await prisma.oAuthClient.create({
      data: {
        id: clientId,
        name: parsed.data.client_name,
        redirectUris: parsed.data.redirect_uris,
      },
    });

    return NextResponse.json(
      {
        client_id: clientId,
        client_name: parsed.data.client_name,
        redirect_uris: parsed.data.redirect_uris,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        // 公共客户端（PKCE），无 secret
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'mcp',
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Invalid client metadata';
    return NextResponse.json({ error: 'invalid_client_metadata', error_description: message }, { status: 400 });
  }
}
