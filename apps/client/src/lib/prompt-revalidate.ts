// Active-invalidation hook clears client 10m TTL cache on admin edits; skips silently when internal URL/token is unset.
import { resolveRuntimeEndpoints } from './runtime-endpoints';

export async function notifyPromptRevalidate(keys: string[]): Promise<boolean> {
  if (keys.length === 0) return true;
  const runtime = resolveRuntimeEndpoints();
  const base = runtime?.webInternalUrl !== undefined ? runtime.webInternalUrl : process.env.WEB_INTERNAL_URL;
  const token = runtime?.internalApiToken ?? process.env.INTERNAL_API_TOKEN;
  if (!base || !token) return false;
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/internal/revalidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': token },
      body: JSON.stringify({ promptKeys: keys }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch (err) {
    console.warn('[prompt-revalidate] client prompt cache notify failed (10min TTL fallback applies):', err);
    return false;
  }
}
