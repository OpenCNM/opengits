import type { DetectionContext, SignalMatch, SourceSignalDetector } from '../types';
import { findPublicBySkeleton } from '../store';
import { buildSkeleton, extractSkeletonPaths, isSkeletonComparable, skeletonHashOf } from '../features';

/**
 * L2 信号：路径骨架 trgm 相似（clone/镜像检测主力）。
 * 骨架从源码树计算（不随转录大纲/讲法变化）：原样克隆 → 与上游骨架几乎逐字节相同；
 * 删改若干文件后 Jaccard 相似度仍在高位。纯确定性比对，GIN 索引粗筛 + similarity 精算。
 *
 * 特征来源优先级：上下文树实时计算 > 行上已持久化签名（publish 等无树调用点）。
 */
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
      // 小型脚手架仓结构通用性太强（人人都有 docs/intro.md），跳过比对防误报
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
