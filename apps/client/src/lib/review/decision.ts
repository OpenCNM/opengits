import type { PipelineScore } from './pipeline-score';
import type { LlmReviewResult } from './llm-review';
import { REVIEW_THRESHOLDS, type ReviewThresholds } from './config';

export type ReviewDecisionAction = 'AUTO_PUBLISH' | 'SAFETY_HOLD';

export interface ReviewDecision {
  action: ReviewDecisionAction;
  rationale: string;
  scores: { pipeline: number; llm: number; confidence: number };
}

export function decideReview(
  pipeline: PipelineScore,
  llm: LlmReviewResult,
  thresholds: ReviewThresholds = REVIEW_THRESHOLDS
): ReviewDecision {
  const scores = { pipeline: pipeline.total, llm: llm.overallScore, confidence: llm.confidence };

  // Fail closed to manual review whenever pipeline or LLM review channels are unavailable.
  if (pipeline.unavailable) {
    return {
      action: 'SAFETY_HOLD',
      rationale: '管线评分通道不可用（AST 语法审计 sidecar 未就绪），已转入人工审核队列',
      scores,
    };
  }

  if (llm.unavailable) {
    return {
      action: 'SAFETY_HOLD',
      rationale: 'LLM 初审通道不可用，为防未经安全评估的内容直接公开，已转入人工审核队列',
      scores,
    };
  }

  if (llm.safetyFlag) {
    return {
      action: 'SAFETY_HOLD',
      rationale: `LLM 初审判定存在安全风险（${llm.concerns.slice(0, 2).join('；') || '详见判定'}）→ 扣留待人工安全复核`,
      scores,
    };
  }

  if (thresholds.enforceQualityGate) {
    if (pipeline.total < thresholds.pipelinePass) {
      return {
        action: 'SAFETY_HOLD',
        rationale: `管线质量分 (${pipeline.total} 分) 低于设定的基准线 (${thresholds.pipelinePass} 分)，已转入人工复核`,
        scores,
      };
    }
    if (llm.overallScore < thresholds.llmPass) {
      return {
        action: 'SAFETY_HOLD',
        rationale: `AI 初审分 (${llm.overallScore} 分) 低于设定的基准线 (${thresholds.llmPass} 分)，已转入人工复核`,
        scores,
      };
    }
    if (llm.confidence < thresholds.confidenceMin) {
      return {
        action: 'SAFETY_HOLD',
        rationale: `AI 评估置信度 (${llm.confidence}) 低于设定的最低置信门禁 (${thresholds.confidenceMin})，已转入人工复核`,
        scores,
      };
    }
  }

  return {
    action: 'AUTO_PUBLISH',
    rationale: `通过安全门与质量基准，自动公开（管线 ${pipeline.total} · AI ${llm.overallScore} · 置信度 ${llm.confidence}，分数进雷达与推荐排序）`,
    scores,
  };
}
