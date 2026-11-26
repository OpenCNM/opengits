import { resolveRuntimeEndpoints } from './runtime-endpoints';
import { callSidecar } from './sidecar-client';

export interface SidecarRuntimePolicyState {
  ok: boolean;
  emergencyReadOnly: boolean;
  transcriptionConcurrency: number;
  transcriptionChunkConcurrency: number;
  activeTranscriptions: number;
  safeMode: boolean;
}

export interface RuntimePolicyNotifyResult {
  webNotified: boolean;
  sidecarNotified: boolean;
  sidecarState: SidecarRuntimePolicyState | null;
}

async function notifyWebPolicyReload(): Promise<boolean> {
  const runtime = resolveRuntimeEndpoints();
  const base = runtime?.webInternalUrl !== undefined ? runtime.webInternalUrl : process.env.WEB_INTERNAL_URL;
  const token = runtime?.internalApiToken ?? process.env.INTERNAL_API_TOKEN;
  if (!base || !token) return false;
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/internal/revalidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': token },
      body: JSON.stringify({ reloadRuntimePolicy: true }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch (err) {
    console.warn('[runtime-policy-sync] web policy reload notify failed (10s TTL fallback applies):', err);
    return false;
  }
}

async function notifySidecarPolicyReload(): Promise<SidecarRuntimePolicyState | null> {
  try {
    return await callSidecar<SidecarRuntimePolicyState>(
      '/v1/policy/reload',
      {},
      { label: 'runtime-policy /v1/policy/reload', timeoutMs: 3000 },
    );
  } catch (err) {
    console.warn('[runtime-policy-sync] sidecar policy reload notify failed (10s TTL fallback applies):', err);
    return null;
  }
}

export async function notifyRuntimePolicyReload(): Promise<RuntimePolicyNotifyResult> {
  const [webNotified, sidecarState] = await Promise.all([
    notifyWebPolicyReload(),
    notifySidecarPolicyReload(),
  ]);
  return {
    webNotified,
    sidecarNotified: Boolean(sidecarState?.ok),
    sidecarState,
  };
}
