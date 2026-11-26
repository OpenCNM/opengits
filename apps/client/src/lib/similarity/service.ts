import type { DetectionContext, SignalMatch, SourceDetectionResult } from './types';
import { SOURCE_DETECTORS } from './registry';

// Isolates detector errors and excludes the repository itself (multiple editions share identical skeletons).
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
