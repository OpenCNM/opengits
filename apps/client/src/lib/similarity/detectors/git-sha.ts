import type { SignalMatch, SourceSignalDetector } from '../types';
import { findPublicByGitSha } from '../store';
import { extractSkeletonPaths, SKELETON_MIN_PATHS } from '../features';

/**
 * L0 信号：gitSha 等值。
 * `git clone` + push 到新仓库保留完整历史 → HEAD sha 与上游逐字节一致（铁证，置信 1.0）。
 * 对方补一个 commit 即失效——只抓懒惰 clone，主力是骨架信号。
 */
export const gitShaDetector: SourceSignalDetector = {
  key: 'git-sha',
  async extract(ctx) {
    if (!ctx.gitSha) return null;
    // 防御模板仓初始 Commit 碰撞（BUG-08）：
    // 若树节点已提供，但有效内容路径少于最小特征门禁（含全被过滤的 0 路径——
    // 纯 LICENSE/.gitignore 类空壳模板），跳过单一 sha 命中防误归簇
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
