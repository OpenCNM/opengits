import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export const INSECURE_DEFAULT_TOKEN = 'dev-internal-token-change-me';

export function tokenEquals(received: string | null, expected: string): boolean {
  if (typeof received !== 'string' || received.length === 0) return false;
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(received), digest(expected));
}

// Uses timing-safe digest equality and rejects compose fallback tokens in production.
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
