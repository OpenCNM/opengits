/**
 * 教程公开审核配置（安全门模型，2026-08-16 翻转）。
 *
 * 安全=门：LLM safetyFlag（仅明显有害/违法/侵权）扣留待人工复核；
 * 质量=分：其余一切自动公开，分数进雷达图与推荐排序消化。
 * 阈值仅用于雷达轴的通过标记（passed flag），不再拦截发布。
 */

export interface ReviewThresholds {
  /** 管线分通过线（0-100，雷达轴标记用） */
  pipelinePass: number;
  /** LLM 分通过线（0-100，雷达轴标记用） */
  llmPass: number;
  /** LLM 置信度参考线（雷达面板展示用） */
  confidenceMin: number;
  /** 是否开启质量基线硬门禁：false=软基线仅做排序与勋章（默认），true=低于基线拦截转人工 */
  enforceQualityGate?: boolean;
}

export const REVIEW_THRESHOLDS: ReviewThresholds = {
  pipelinePass: 70,
  llmPass: 75,
  confidenceMin: 0.7,
  enforceQualityGate: false,
};

/** 审核状态机取值（与 Prisma Repository.reviewStatus 注释同步） */
export type ReviewStatus = 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED';

/** 举报理由枚举（与 ContentReport.reason 注释同步） */
export const REPORT_REASONS = ['INFRINGEMENT', 'LOW_QUALITY', 'MALICIOUS', 'OTHER'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  INFRINGEMENT: '侵权/许可问题',
  LOW_QUALITY: '内容质量差',
  MALICIOUS: '恶意/违规内容',
  OTHER: '其他',
};
