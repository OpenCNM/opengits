import type { DetectionContext, SignalMatch, SourceSignalDetector } from '../types';
import { findPublicBySkeleton } from '../store';
import { buildSkeleton, extractSkeletonPaths, isSkeletonComparable, skeletonHashOf } from '../features';

export const skeletonTrgmDetector: SourceSignalDetector = {
  key: 'skeleton-trgm',
  async extract(ctx: DetectionContext) {
    let skeleton: string | null = null;
    if (ctx.treeNodes && ctx.treeNodes.length > 0) {
      const paths = extractSkeletonPaths(ctx.treeNodes);
      if (paths.length > 0) {
        skeleton = buildSkeleton(paths);
      }
    }
    if (!skeleton && ctx.existingSignature?.skeleton) {
      skeleton = ctx.existingSignature.skeleton;
    }
    if (!skeleton || !isSkeletonComparable(skeleton)) {
      return null;
    }
    return { detectorKey: 'skeleton-trgm', skeleton, skeletonHash: skeletonHashOf(skeleton) };
  },
  async match(feature, opts): Promise<SignalMatch[]> {
    if (feature.detectorKey !== 'skeleton-trgm') return [];
    const rows = await findPublicBySkeleton(
      feature.skeleton,
      opts?.exclude ?? { owner: '', repo: '' },
      opts?.limit ?? 3
    );
    return rows.map((r) => ({
      detectorKey: 'skeleton-trgm',
      repositoryId: r.id,
      owner: r.owner,
      repo: r.repo,
      similarity: Math.min(1, Math.max(0, r.similarity)),
    }));
  },
};
