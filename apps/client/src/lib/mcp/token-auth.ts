import { NextRequest } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';
import { ignoreBestEffort } from '@/lib/best-effort';
import { getSessionHelper } from '@/lib/auth-helper';
import { prisma } from '@/lib/db';
import { callSidecar } from '@/lib/sidecar-client';
import { TtlCache } from '@/lib/cache/ttl-cache';

export interface McpAuthResult {
  userId: string | null;
  via: 'token' | 'cookie' | null;
}

export function generateApiToken(): string {
  return `opgts_${randomBytes(16).toString('hex')}`;
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function extractBearerToken(request: NextRequest): string | null {
  const authHeader = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (match && match[1]?.trim()) {
    return match[1].trim();
  }
  const tokenQuery = request.nextUrl?.searchParams?.get('token') || request.nextUrl?.searchParams?.get('apiKey');
  if (tokenQuery?.trim()) {
    return tokenQuery.trim();
  }
  return null;
}

// Bounded 60s positive / 10s negative cache prevents DB floods from invalid tokens; sidecar edge enforces 5m revocation bound.
interface TokenCacheEntry {
  userId: string;
  tokenId: string;
}

const TOKEN_CACHE_TTL_MS = 60 * 1000;
const TOKEN_CACHE_NEG_TTL_MS = 10 * 1000;
const TOKEN_CACHE_MAX_ENTRIES = 5000;

const tokenCache = new TtlCache<TokenCacheEntry | null>(TOKEN_CACHE_TTL_MS, TOKEN_CACHE_MAX_ENTRIES);

const TOKEN_TOUCH_INTERVAL_MS = 60 * 1000;
const tokenTouchThrottle = new TtlCache<number>(TOKEN_TOUCH_INTERVAL_MS, TOKEN_CACHE_MAX_ENTRIES);

const roleCache = new TtlCache<string>(TOKEN_CACHE_TTL_MS, TOKEN_CACHE_MAX_ENTRIES);

export async function getRoleForMcpUser(userId: string): Promise<string> {
  const hit = roleCache.get(userId);
  if (hit) return hit;
  const user = await prisma.user
    .findUnique({ where: { id: userId }, select: { role: true } })
    .catch(() => { ignoreBestEffort(); return null; });
  const role = user?.role || 'USER';
  roleCache.set(userId, role);
  return role;
}

function touchTokenLastUsedThrottled(tokenId: string) {
  if (tokenTouchThrottle.has(tokenId)) return;
  tokenTouchThrottle.set(tokenId, Date.now());
  void callSidecar('/v1/mcp/tokens/touch', { id: tokenId }, { label: 'mcp-token-touch' }).catch(ignoreBestEffort);
}

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
      .catch(() => { ignoreBestEffort(); return null; });

    if (record) {
      tokenCache.set(tokenHash, { userId: record.userId, tokenId: record.id }, TOKEN_CACHE_TTL_MS);
      touchTokenLastUsedThrottled(record.id);
      return { userId: record.userId, via: 'token' };
    }
    tokenCache.set(tokenHash, null, TOKEN_CACHE_NEG_TTL_MS);
    // Invalid or revoked bearer tokens fail closed immediately and never fall back to session cookies.
    return { userId: null, via: 'token' };
  }

  const session = await getSessionHelper();
  if (session?.user?.id) {
    return { userId: session.user.id, via: 'cookie' };
  }
  return { userId: null, via: null };
}
