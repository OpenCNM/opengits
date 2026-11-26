import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionHelper } from '@/lib/auth-helper';
import { randomBytes, createHash } from 'node:crypto';
import { isRedirectUriAllowed } from '@/lib/schemas/oauth';
import * as m from '@/paraglide/messages';
import { ignoreBestEffort } from '@/lib/best-effort';

const CODE_TTL_MS = 5 * 60 * 1000;

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getOAuthLocale(req: NextRequest): 'en' | 'zh-CN' {
  const cookie = req.cookies.get('PARAGLIDE_LOCALE')?.value || req.cookies.get('NEXT_LOCALE')?.value;
  if (cookie === 'zh-CN' || cookie === 'en') return cookie;
  const acceptLang = req.headers.get('accept-language') || '';
  if (acceptLang.toLowerCase().startsWith('zh')) return 'zh-CN';
  return 'en';
}

function oauthIssuer(): string {
  return process.env.NEXTAUTH_URL || 'http://localhost:3000';
}

function isAllowedOAuthResource(resource: string): boolean {
  if (!resource) return true;
  try {
    return new URL(resource).origin === new URL(oauthIssuer()).origin;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  const locale = getOAuthLocale(req);
  const url = new URL(req.url);
  const clientId = url.searchParams.get('client_id') || '';
  const redirectUri = url.searchParams.get('redirect_uri') || '';
  const codeChallenge = url.searchParams.get('code_challenge') || '';
  const method = url.searchParams.get('code_challenge_method') || '';
  const state = url.searchParams.get('state') || '';
  const scope = url.searchParams.get('scope') || 'mcp';

  if (!clientId || !redirectUri || !codeChallenge || method !== 'S256') {
    return NextResponse.json(
      { error: 'invalid_request', error_description: m.api_err_invalid_param(undefined, { locale }) },
      { status: 400 }
    );
  }

  const client = await prisma.oAuthClient.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, redirectUris: true },
  });
  if (!client) {
    return NextResponse.json(
      { error: 'unauthorized_client', error_description: m.error_forbidden_title(undefined, { locale }) },
      { status: 400 }
    );
  }

  const resourceParam = url.searchParams.get('resource') || '';
  if (!isAllowedOAuthResource(resourceParam)) {
    const errRedirect = new URL(redirectUri);
    errRedirect.searchParams.set('error', 'invalid_target');
    errRedirect.searchParams.set('error_description', 'resource parameter origin does not match this authorization server');
    if (state) errRedirect.searchParams.set('state', state);
    return NextResponse.redirect(errRedirect);
  }

  if (!isRedirectUriAllowed(redirectUri, client.redirectUris)) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: m.api_err_invalid_param(undefined, { locale }) },
      { status: 400 }
    );
  }

  const session = await getSessionHelper();
  if (!session?.user?.id) {
    const loginUrl = new URL('/auth/signin', url.origin);
    loginUrl.searchParams.set('callbackUrl', req.url);
    return NextResponse.redirect(loginUrl);
  }

  const safeClientId = escapeHtml(clientId);
  const safeRedirectUri = escapeHtml(redirectUri);
  const safeCodeChallenge = escapeHtml(codeChallenge);
  const safeState = escapeHtml(state);
  const safeScope = escapeHtml(scope);
  const safeClientName = escapeHtml(client.name);

  const title = m.oauth_authorize_title(undefined, { locale });
  const prompt = m.oauth_authorize_prompt({ clientName: safeClientName }, { locale });
  const allow = m.oauth_authorize_allow(undefined, { locale });

  return new NextResponse(
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;color:CanvasText}button{padding:10px 22px;border-radius:8px;border:1px solid ButtonText;background:ButtonFace;color:ButtonText;font-size:14px;cursor:pointer}</style></head>
<body><form method="POST"><input type="hidden" name="client_id" value="${safeClientId}"><input type="hidden" name="redirect_uri" value="${safeRedirectUri}"><input type="hidden" name="code_challenge" value="${safeCodeChallenge}"><input type="hidden" name="state" value="${safeState}"><input type="hidden" name="scope" value="${safeScope}"><input type="hidden" name="resource" value="${escapeHtml(resourceParam)}">
<div style="text-align:center"><h2>${escapeHtml(title)}</h2><p style="color:inherit;opacity:.65;font-size:13px">${escapeHtml(prompt)}</p><button type="submit">${escapeHtml(allow)}</button></div></form></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export async function POST(req: NextRequest) {
  const locale = getOAuthLocale(req);
  const session = await getSessionHelper();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'access_denied' }, { status: 401 });
  }
  const form = await req.formData().catch(() => {
    ignoreBestEffort();
    return null;
  });
  const clientId = String(form?.get('client_id') || '');
  const redirectUri = String(form?.get('redirect_uri') || '');
  const codeChallenge = String(form?.get('code_challenge') || '');
  const state = String(form?.get('state') || '');
  const resourceParam = String(form?.get('resource') || '');
  if (!clientId || !redirectUri || !codeChallenge) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (!isAllowedOAuthResource(resourceParam)) {
    return NextResponse.json({ error: 'invalid_target' }, { status: 400 });
  }

  const client = await prisma.oAuthClient.findUnique({
    where: { id: clientId },
    select: { id: true, redirectUris: true },
  });
  if (!client) {
    return NextResponse.json({ error: 'unauthorized_client' }, { status: 400 });
  }
  if (!isRedirectUriAllowed(redirectUri, client.redirectUris)) {
    return NextResponse.json({ error: 'invalid_request', error_description: m.api_err_invalid_param(undefined, { locale }) }, { status: 400 });
  }

  prisma.oAuthAuthCode
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .catch(ignoreBestEffort);

  const code = base64url(randomBytes(32));
  await prisma.oAuthAuthCode.create({
    data: {
      code,
      clientId,
      userId: session.user.id,
      codeChallenge,
      redirectUri,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });

  const redirect = new URL(redirectUri);
  redirect.searchParams.set('code', code);
  if (state) redirect.searchParams.set('state', state);
  redirect.searchParams.set('iss', oauthIssuer());
  return NextResponse.redirect(redirect);
}

export async function consumeAuthCode(code: string, verifier: string): Promise<{
  clientId: string;
  userId: string;
  codeChallenge: string;
  redirectUri: string;
} | null> {
  if (!code || !verifier) return null;

  const entry = await prisma.oAuthAuthCode.delete({
    where: { code },
  }).catch(() => null);

  if (!entry) return null;
  if (entry.expiresAt.getTime() < Date.now()) return null;

  const expected = base64url(createHash('sha256').update(verifier).digest());
  if (expected !== entry.codeChallenge) return null;

  return {
    clientId: entry.clientId,
    userId: entry.userId,
    codeChallenge: entry.codeChallenge,
    redirectUri: entry.redirectUri,
  };
}
