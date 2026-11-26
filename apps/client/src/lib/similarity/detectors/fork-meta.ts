import type { SignalMatch, SourceSignalDetector } from '../types';
import { findPublicByCanonicalRepo } from '../store';

export const forkMetaDetector: SourceSignalDetector = {
  key: 'fork-meta',
  async extract(ctx) {
    if (!ctx.forkUpstream) return null;
    return { detectorKey: 'fork-meta', upstream: ctx.forkUpstream };
  },
  async match(feature, opts): Promise<SignalMatch[]> {
    if (feature.detectorKey !== 'fork-meta') return [];
    const row = await findPublicByCanonicalRepo(feature.upstream.owner, feature.upstream.repo);
    if (!row) return [];
    if (
      opts?.exclude &&
      row.owner.toLowerCase() === opts.exclude.owner.toLowerCase() &&
      row.repo.toLowerCase() === opts.exclude.repo.toLowerCase()
    ) {
      return [];
    }
    return [
      {
        detectorKey: 'fork-meta',
        repositoryId: row.id,
        owner: row.owner,
        repo: row.repo,
        similarity: 0.9,
      },
    ];
  },
};
