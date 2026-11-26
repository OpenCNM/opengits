import type { NextRequest } from 'next/server';

const bodyJsonCache = new WeakMap<Request, Promise<any>>();

export function readBodyJson(request: NextRequest | Request): Promise<any> {
  let parsed = bodyJsonCache.get(request);
  if (!parsed) {
    parsed = request.clone().json().catch(() => null);
    bodyJsonCache.set(request, parsed);
  }
  return parsed;
}
