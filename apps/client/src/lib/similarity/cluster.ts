import type { SourceDetectionResult } from './types';
import { getClusterKeyOf } from './store';
import { callSidecar } from '@/lib/sidecar-client';

// Cluster keys affect display grouping only and never restrict visibility or publishing.

export function summarizeDetection(result: SourceDetectionResult) {
  if (!result.best) return null;
  return {
    owner: result.best.owner,
    repo: result.best.repo,
    similarity: Math.round(result.best.similarity * 100) / 100,
    method: result.best.detectorKey,
  };
}

export function mergeSameSourceIntoProfile(
  repoProfile: Record<string, unknown>,
  result: SourceDetectionResult
): Record<string, unknown> {
  const summary = summarizeDetection(result);
  if (!summary) return repoProfile;
  return { ...repoProfile, sameSource: summary };
}

export async function adoptCluster(
  repositoryId: string,
  selfFallbackKey: string,
  result: SourceDetectionResult
): Promise<string | null> {
  try {
    let clusterKey: string;
    if (result.best) {
      clusterKey = (await getClusterKeyOf(result.best.repositoryId)) ?? `${result.best.owner}/${result.best.repo}`;
    } else {
      clusterKey = selfFallbackKey;
    }
    await callSidecar(
      '/v1/repos/patch',
      {
        id: repositoryId,
        sourceClusterKey: clusterKey,
      },
      { label: 'similarity-adopt-cluster' }
    );
    return clusterKey;
  } catch (err) {
    console.warn('[similarity/cluster] adoptCluster failed (silent):', err);
    return null;
  }
}
