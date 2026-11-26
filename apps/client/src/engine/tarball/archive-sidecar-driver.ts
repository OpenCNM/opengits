import { callSidecar } from '../../lib/sidecar-client';

interface SidecarEnsureResponse {
  dir: string | null;
  fromCache: boolean;
}

export async function ensureArchiveViaSidecar(
  owner: string,
  repo: string,
  sha: string,
  options?: { token?: string; signal?: AbortSignal; sizeHintBytes?: number; timeoutMs?: number },
): Promise<{ dir: string | null; fromCache: boolean }> {
  const data = await callSidecar<SidecarEnsureResponse>(
    '/v1/archive/ensure',
    {
      owner,
      repo,
      sha,
      sizeHintBytes: options?.sizeHintBytes ?? 0,
      token: options?.token ?? '',
    },
    {
      label: 'archive /v1/archive/ensure',
      signal: options?.signal,
      timeoutMs: options?.timeoutMs ?? 300_000,
    },
  );
  return { dir: data.dir, fromCache: data.fromCache };
}
