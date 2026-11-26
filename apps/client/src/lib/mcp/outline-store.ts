import { callSidecar } from '@/lib/sidecar-client';
import { OutlineDraft } from './ingest-orchestrator';
import { invalidateWebL1Projection } from '@/lib/docs/web-outline-projection';

export interface StoreOutlineDraftOptions {
  isActive?: boolean;
}

// Create Outline + Parts first because Chapter.partId requires persisted Part IDs; invalidates L1 projection on activation.
export async function storeOutlineDraft(
  repositoryId: string,
  draft: OutlineDraft,
  opts?: StoreOutlineDraftOptions,
): Promise<string> {
  const res = await callSidecar<{ ok: boolean; outlineId: string }>(
    '/v1/outlines/draft/store',
    {
      repositoryId,
      draft,
      isActive: opts?.isActive ?? false,
    },
    { label: 'store outline draft' }
  );

  if (opts?.isActive ?? false) {
    invalidateWebL1Projection(repositoryId);
  }

  return res.outlineId;
}

export async function activateOutline(
  repositoryId: string,
  outlineId: string,
): Promise<void> {
  await callSidecar(
    '/v1/outlines/activate',
    { repositoryId, outlineId },
    { label: 'activate outline' }
  );

  invalidateWebL1Projection(repositoryId);
}

export async function deactivateAllOutlines(
  repositoryId: string,
): Promise<void> {
  await callSidecar(
    '/v1/outlines/deactivate',
    { repositoryId },
    { label: 'deactivate all outlines' }
  );

  invalidateWebL1Projection(repositoryId);
}
