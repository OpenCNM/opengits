import { DEFAULT_PLATFORM_URL } from '@/lib/constants';

export function getClientOrigin(fallback: string = ''): string {
  if (typeof window !== 'undefined' && window.location.origin) {
    return window.location.origin;
  }
  return process.env.NEXT_PUBLIC_APP_URL || fallback;
}

export function getBaseUrl(fallback: string = DEFAULT_PLATFORM_URL): string {
  const url =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : fallback);
  return url.replace(/\/+$/, '');
}
