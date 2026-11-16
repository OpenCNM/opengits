import { test, expect } from 'vitest';
import { decideReview } from '@/lib/review/decision';
import type { PipelineScore } from '@/lib/review/pipeline-score';
import type { LlmReviewResult } from '@/lib/review/llm-review';

function pipeline(total: number): PipelineScore {
  return { total, passed: total >= 70, dimensions: [] };
}

function llm(overrides: Partial<LlmReviewResult> = {}): LlmReviewResult {
  return {
    overallScore: 80,
    passed: true,
    confidence: 0.9,
    safetyFlag: false,
    dimensions: [],
    concerns: [],
    summary: 'ok',
    ...overrides,
  };
}

test('safetyFlag → SAFETY_HOLD（唯一扣留条件）', () => {
  const d = decideReview(pipeline(95), llm({ safetyFlag: true, concerns: ['侵权内容', '恶意代码'] }));
  expect(d.action).toBe('SAFETY_HOLD');
  expect(d.rationale).toContain('安全');
});

test('低分/低置信不再拦截——安全=门、质量=分（哲学翻转后语义）', () => {
  const d = decideReview(pipeline(30), llm({ overallScore: 20, confidence: 0.2 }));
  expect(d.action).toBe('AUTO_PUBLISH');
  expect(d.scores).toEqual({ pipeline: 30, llm: 20, confidence: 0.2 });
});

test('LLM 不可用 → fail-closed 转人工复核（SAFETY_HOLD），不放行', () => {
  const d = decideReview(pipeline(50), llm({ unavailable: true, overallScore: 0, confidence: 0 }));
  expect(d.action).toBe('SAFETY_HOLD');
  expect(d.rationale).toContain('不可用');
});

test('管线通道不可用 → fail-closed 转人工复核（SAFETY_HOLD），不放行', () => {
  const d = decideReview({ total: 0, passed: false, unavailable: true, dimensions: [] }, llm());
  expect(d.action).toBe('SAFETY_HOLD');
  expect(d.rationale).toContain('不可用');
});
