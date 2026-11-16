import { NextRequest, NextResponse } from 'next/server';
import { generateApiToken, hashApiToken } from '@/lib/mcp/token-auth';
import { prisma } from '@/lib/db';
import { callSidecar } from '@/lib/sidecar-client';
import { consumeAuthCode } from '../authorize/route';
import * as m from '@/paraglide/messages';

/**
 * OAuth 2.1 token 端点：authorization_code + PKCE 兑换。
 * 签发的 access_token 即 McpApiToken（sha256 落库，Bearer 全链路复用 request-guard 鉴权/配额/限速）。
 */
export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') || '';
    let grantType = '', code = '', codeVerifier = '', clientId = '', clientSecret = '', redirectUri = '';
    if (contentType.includes('application/json')) {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      grantType = String(body.grant_type || '');
      code = String(body.code || '');
      codeVerifier = String(body.code_verifier || '');
      clientId = String(body.client_id || '');
      clientSecret = String(body.client_secret || '');
      redirectUri = String(body.redirect_uri || '');
    } else {
      const form = await req.formData().catch(() => null);
      grantType = String(form?.get('grant_type') || '');
      code = String(form?.get('code') || '');
      codeVerifier = String(form?.get('code_verifier') || '');
      clientId = String(form?.get('client_id') || '');
      clientSecret = String(form?.get('client_secret') || '');
      redirectUri = String(form?.get('redirect_uri') || '');
    }
    void clientSecret; // 公共客户端（MCP 智能体）走 PKCE，不强制 client_secret

    if (grantType !== 'authorization_code') {
      return NextResponse.json({ error: 'unsupported_grant_type' }, { status: 400 });
    }
    if (!code || !codeVerifier || !clientId) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }

    const cookie =
      req?.cookies?.get?.('PARAGLIDE_LOCALE')?.value ||
      req?.cookies?.get?.('NEXT_LOCALE')?.value;
    const locale =
      cookie === 'zh-CN' || cookie === 'en'
        ? cookie
        : req?.headers?.get?.('accept-language')?.toLowerCase().startsWith('en')
          ? 'en'
          : 'zh-CN';

    const entry = await consumeAuthCode(code, codeVerifier);
    if (
      !entry ||
      entry.clientId !== clientId ||
      (entry.redirectUri ? !redirectUri || entry.redirectUri !== redirectUri : Boolean(redirectUri))
    ) {
      return NextResponse.json(
        { error: 'invalid_grant', error_description: m.oauth_err_invalid_grant(undefined, { locale }) },
        { status: 400 },
      );
    }

    const MAX_TOKENS_PER_USER = 20;
    const tokenName = `OAuth:${clientId}`.slice(0, 50);

    // OAuth 自愈清扫：若用户活跃 Token 达上限或同客户端重新授权，软撤销该客户端旧 Token
    if (prisma.mcpApiToken.findMany) {
      try {
        const activeTokens = await prisma.mcpApiToken.findMany({
          where: { userId: entry.userId, revokedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true, name: true },
        });

        if (activeTokens.length >= MAX_TOKENS_PER_USER) {
          const candidateToRevoke = activeTokens.find((t) => t.name === tokenName) ?? activeTokens[0];
          if (candidateToRevoke) {
            await callSidecar(
              '/v1/mcp/tokens/revoke',
              { id: candidateToRevoke.id, userId: entry.userId },
              { label: 'oauth-revoke-mcp-token' }
            );
          }
        }
      } catch (cleanupErr) {
        // 非阻断自愈：撤销失败不阻断签发，但必须留痕——否则配额上限失效无从观测
        console.warn('[oauth/token] Non-blocking token-quota self-heal failed:', cleanupErr);
      }
    }

    // 签发与手动创建完全同构的 McpApiToken（下沉 Go worker-sidecar 单一写者）
    const plainToken = generateApiToken();
    const tokenRes = await callSidecar<{
      ok: boolean;
      token?: { id: string; createdAt: string };
      error?: string;
    }>(
      '/v1/mcp/tokens/create',
      {
        userId: entry.userId,
        name: tokenName,
        tokenHash: hashApiToken(plainToken),
        prefix: plainToken.slice(0, 8),
      },
      { label: 'oauth-create-mcp-token' }
    );

    if (!tokenRes.ok) {
      throw new Error(tokenRes.error || 'Failed to issue token via sidecar');
    }

    const createdTime = tokenRes.token?.createdAt
      ? Math.floor(new Date(tokenRes.token.createdAt).getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    return NextResponse.json({
      access_token: plainToken,
      token_type: 'Bearer',
      scope: 'mcp',
      // PAT 无过期机制：按 RFC 6749 省略 expires_in（谎报 90 天会让客户端到期主动废弃
      // 实际仍有效的 token）；客户端遇 401 时重新走授权流即可
      created_at: createdTime,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    console.error('[OAuthToken] POST Error:', error);
    return NextResponse.json({ error: 'server_error', error_description: message }, { status: 500 });
  }
}
