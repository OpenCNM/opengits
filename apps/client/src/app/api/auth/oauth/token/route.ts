import { NextRequest, NextResponse } from 'next/server';
import { generateApiToken, hashApiToken } from '@/lib/mcp/token-auth';
import { prisma } from '@/lib/db';
import { callSidecar } from '@/lib/sidecar-client';
import { consumeAuthCode } from '../authorize/route';
import * as m from '@/paraglide/messages';
import { ignoreBestEffort } from '@/lib/best-effort';

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
      const form = await req.formData().catch(() => {
        ignoreBestEffort();
        return null;
      });
      grantType = String(form?.get('grant_type') || '');
      code = String(form?.get('code') || '');
      codeVerifier = String(form?.get('code_verifier') || '');
      clientId = String(form?.get('client_id') || '');
      clientSecret = String(form?.get('client_secret') || '');
      redirectUri = String(form?.get('redirect_uri') || '');
    }
    void clientSecret;

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
        console.warn('[oauth/token] Non-blocking token-quota self-heal failed:', cleanupErr);
      }
    }

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
      created_at: createdTime,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    console.error('[OAuthToken] POST Error:', error);
    return NextResponse.json({ error: 'server_error', error_description: message }, { status: 500 });
  }
}
