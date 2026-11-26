import { api, ApiClientError } from '@/lib/api/client';
import { STORAGE_KEYS } from '@/lib/constants';

export const TIER_REPO_LIMIT_CODE = 'TIER_REPO_LIMIT';

export function isTierRepoLimitError(err: unknown): err is ApiClientError {
  return err instanceof ApiClientError && err.code === TIER_REPO_LIMIT_CODE;
}

export interface IngestJobResponse {
  jobId?: string;
  deduped?: boolean;
  reused?: boolean;
  repositoryId?: string;
  owner?: string;
  repo?: string;
  message?: string;
}

export interface LastImportJobMeta {
  jobId: string;
  owner: string;
  repo: string;
  edition?: string;
}

export async function submitIngestRequest(
  endpoint: '/api/ingest' | '/api/ingest/web-doc',
  payload: Record<string, unknown>,
  opts?: { signal?: AbortSignal }
): Promise<IngestJobResponse> {
  const created = await api.post<IngestJobResponse>(endpoint, payload, {
    onUnauthorized: 'throw',
    signal: opts?.signal,
  });
  if (!created?.jobId && !created?.reused) {
    throw new Error('Ingest endpoint returned no job id');
  }
  return created;
}

export function persistLastImportJob(meta: LastImportJobMeta): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(
      STORAGE_KEYS.LAST_IMPORT_JOB,
      JSON.stringify({ ...meta, createdAt: Date.now() })
    );
  } catch {}
}
