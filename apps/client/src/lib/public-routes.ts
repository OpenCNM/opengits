export const PUBLIC_API_PREFIXES = [
  '/api/auth/',
  '/api/webhooks/',
  '/api/internal/',
  '/api/mcp/',
  '/api/docs-content/',
  '/api/assets/',
  '/api/versions/',
  '/api/repos/',
  '/api/update/jobs/',
  '/api/llms-txt/',
  '/api/ingest-status/',
  '/api/ingest/',
  '/api/documents/',
  '/api/chapter-versions/',
] as const;

export const PUBLIC_API_EXACT = [
  '/api/health',
  '/api/user/credits',
  '/api/mcp',
  '/api/ai/providers',
  '/api/update/jobs',
  '/api/repositories/reading-progress/sync',
] as const;

export function isMcpProtocolPath(pathname: string): boolean {
  return pathname === '/api/mcp' || pathname.startsWith('/api/mcp/');
}

export function isPublicApiPath(pathname: string): boolean {
  for (const exact of PUBLIC_API_EXACT) {
    if (pathname === exact) return true;
  }
  for (const prefix of PUBLIC_API_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  return false;
}
