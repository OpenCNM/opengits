import type { SignalMatch, SourceSignalDetector } from '../types';
import { findPublicByCanonicalRepo } from '../store';

/**
 * L1 信号：GitHub fork 元数据（parent/source 字段，scout 期一次 API 调用已带出）。
 * 复用发布判重的 canonicalize 归一口径；clone（fork:false）天然探测不到——
 * 那是骨架信号（L2）的职责。置信 0.9：元数据是 GitHub 打的，可靠但非内容证据。
 */
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
    // 上游即自身（理论不可能，防御）/ 排除自身仓
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
