import { callSidecar } from '@/lib/sidecar-client';
import { ignoreBestEffort } from '@/lib/best-effort';
import { REVIEW_THRESHOLDS } from './config';

export interface PipelineDimension {
  key:
    | 'completeness'
    | 'syntaxHealth'
    | 'grounding'
    | 'structure'
    | 'coverage'
    | 'practicality'
    | 'pedagogy'
    | 'modernity'
    | 'production'
    | string;
  label: string;
  score: number;
  detail: string;
}

export interface PipelineScore {
  total: number;
  passed: boolean;
  unavailable?: boolean;
  dimensions: PipelineDimension[];
}

// Fail closed via unavailable flag on sidecar outage; never substitute local regex scoring.
export async function computePipelineScore(repositoryId: string): Promise<PipelineScore> {
  try {
    const audit = await callSidecar<{
      ok: boolean;
      score: number;
      floor: number;
      dimensions?: PipelineDimension[];
      dims?: { coverage: number; practicality: number; pedagogy: number; modernity: number; production: number };
    }>(
      '/v1/market/repo-audit',
      { repositoryId, enforce: false },
      { label: 'review-pipeline-score-physical', timeoutMs: 30_000 }
    );
    if (audit?.ok) {
      if (Array.isArray(audit.dimensions) && audit.dimensions.length > 0) {
        return {
          total: audit.score,
          passed: audit.score >= REVIEW_THRESHOLDS.pipelinePass,
          dimensions: audit.dimensions.map((d) => ({
            key: d.key,
            label: d.label,
            score: d.score,
            detail: d.detail,
          })),
        };
      }
      if (audit.dims) {
        const d = audit.dims;
        return {
          total: audit.score,
          passed: audit.score >= REVIEW_THRESHOLDS.pipelinePass,
          dimensions: (
            [
              ['coverage', '内容覆盖', d.coverage],
              ['practicality', '实操密度', d.practicality],
              ['pedagogy', '教学结构', d.pedagogy],
              ['modernity', '现代特性', d.modernity],
              ['production', '工程健壮', d.production],
            ] as const
          ).map(([key, label, score]) => ({ key, label, score, detail: '物理完整性与语法体检（Go sidecar）' })),
        };
      }
    }
  } catch {
    ignoreBestEffort();
  }
  return {
    total: 0,
    passed: false,
    unavailable: true,
    dimensions: [],
  };
}
