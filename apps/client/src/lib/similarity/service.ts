import type { DetectionContext, SignalMatch, SourceDetectionResult } from './types';
import { SOURCE_DETECTORS } from './registry';

/**
 * 检测编排服务：唯一业务入口。
 * - 顺序执行注册表中的检测器（extract → match），逐个异常隔离（检测是建议性能力，
 *   任何失败只降级为"该信号不可用"，绝不阻断 scout/publish/ingest 业务流）
 * - 合并去重：同一目标仓多信号命中时取最高置信（平局按注册顺序的确定性方法优先）
 * - 排除自身仓库（同仓多讲法行骨架天然相同，不算"同源"）
 */
export async function runSourceDetection(ctx: DetectionContext): Promise<SourceDetectionResult> {
  const exclude = { owner: ctx.owner, repo: ctx.repo };
  const features: SourceDetectionResult['features'] = [];
  const allMatches: SignalMatch[] = [];

  for (const detector of SOURCE_DETECTORS) {
    try {
      if (!detector.extract) continue;
      const feature = await detector.extract(ctx);
      if (!feature) continue;
      features.push(feature);
      const matches = await detector.match(feature, { exclude });
      allMatches.push(...matches);
    } catch (err) {
      console.warn(`[similarity/service] detector "${detector.key}" failed (isolated):`, err);
    }
  }

  // 按 repositoryId 合并：保留最高 similarity；平局取先注册的信号（git-sha > fork > skeleton）
  const methodOrder = new Map(SOURCE_DETECTORS.map((d, i) => [d.key, i]));
  const byTarget = new Map<string, SignalMatch>();
  for (const m of allMatches) {
    const existing = byTarget.get(m.repositoryId);
    if (!existing) {
      byTarget.set(m.repositoryId, m);
      continue;
    }
    if (
      m.similarity > existing.similarity ||
      (m.similarity === existing.similarity &&
        (methodOrder.get(m.detectorKey) ?? 0) < (methodOrder.get(existing.detectorKey) ?? 0))
    ) {
      byTarget.set(m.repositoryId, m);
    }
  }

  const matches = [...byTarget.values()].sort((a, b) => b.similarity - a.similarity);
  return { matches, best: matches[0] ?? null, features };
}
