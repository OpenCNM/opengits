// safetyFlag gates publication; quality thresholds only annotate radar axes unless enforceQualityGate is enabled.

export interface ReviewThresholds {
  pipelinePass: number;
  llmPass: number;
  confidenceMin: number;
  enforceQualityGate?: boolean;
}

export const REVIEW_THRESHOLDS: ReviewThresholds = {
  pipelinePass: 70,
  llmPass: 75,
  confidenceMin: 0.7,
  enforceQualityGate: false,
};

export type ReviewStatus = 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED';

export const REPORT_REASONS = ['INFRINGEMENT', 'LOW_QUALITY', 'MALICIOUS', 'OTHER'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  INFRINGEMENT: '侵权/许可问题',
  LOW_QUALITY: '内容质量差',
  MALICIOUS: '恶意/违规内容',
  OTHER: '其他',
};
