import type { SignalMatch, SourceSignalDetector } from '../types';
import { findPublicByGitSha } from '../store';
import { extractSkeletonPaths, SKELETON_MIN_PATHS } from '../features';

export const gitShaDetector: SourceSignalDetector = {
  key: 'git-sha',
  async extract(ctx) {
    if (!ctx.gitSha) return null;
    // Require minimum content path count so empty template repos with shared initial commits do not collide.
    if (ctx.treeNodes && ctx.treeNodes.length > 0) {
      const paths = extractSkeletonPaths(ctx.treeNodes);
      if (paths.length < SKELETON_MIN_PATHS) {
        return null;
      }
    } else if (ctx.existingSignature?.skeleton !== undefined) {
      const paths = ctx.existingSignature.skeleton ? ctx.existingSignature.skeleton.split('\n').filter(Boolean) : [];
      if (paths.length < SKELETON_MIN_PATHS) {
        return null;
      }
    }
    return { detectorKey: 'git-sha', gitSha: ctx.gitSha };
  },
  async match(feature, opts): Promise<SignalMatch[]> {
    if (feature.detectorKey !== 'git-sha') return [];
    const rows = await findPublicByGitSha(
      feature.gitSha,
      opts?.exclude ?? { owner: '', repo: '' },
      opts?.limit ?? 3
    );
    return rows.map((r) => ({
      detectorKey: 'git-sha',
      repositoryId: r.id,
      owner: r.owner,
      repo: r.repo,
      similarity: 1,
    }));
  },
};
