import type { SourceDetectionResult } from './types';
import { getClusterKeyOf } from './store';
import { callSidecar } from '@/lib/sidecar-client';

/**
 * 归簇策略（与检测分离的消费方策略）：
 * - 命中同源 → 采纳被命中行的簇键（无簇则其 skeletonHash/owner-repo 兜底）
 * - 未命中 → 自成新簇（skeletonHash ?? owner/repo）
 * 广场分组键 = sourceClusterKey ?? (owner, repo)，同源仓归一张卡展示。
 * 只影响展示归组，永不影响可见性/发布资格（零限制原则）。
 */

/** 检测结果的展示摘要（横幅/徽章消费；经 mergeSameSourceIntoProfile 落 repoProfile 供 admin 遥测） */
export function summarizeDetection(result: SourceDetectionResult) {
  if (!result.best) return null;
  return {
    owner: result.best.owner,
    repo: result.best.repo,
    similarity: Math.round(result.best.similarity * 100) / 100,
    method: result.best.detectorKey,
  };
}

/** sameSource 元数据合并进 repoProfile（浅合并，不整对象覆盖——调用方持原 profile 引用防竞态） */
export function mergeSameSourceIntoProfile(
  repoProfile: Record<string, unknown>,
  result: SourceDetectionResult
): Record<string, unknown> {
  const summary = summarizeDetection(result);
  if (!summary) return repoProfile;
  return { ...repoProfile, sameSource: summary };
}

/** 发布/导入后的簇键采纳：只写 sourceClusterKey 列，失败静默（增强能力非关键路径，委托 Go sidecar /v1/repos/patch） */
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
