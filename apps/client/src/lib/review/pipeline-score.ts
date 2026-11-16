import { prisma } from '@/lib/db';
import { callSidecar } from '@/lib/sidecar-client';
import { REVIEW_THRESHOLDS } from './config';

/**
 * 教程管线特质评分（Pedagogical Traits）：从转录落库数据计算内容与教学特质。
 * 五维度：模块覆盖 / 代码实操 / 认知梯度 / 前沿时效 / 生产实战。
 * 结合 LLM 的「架构深度」，共同组成 6 维教程特性画像。
 *
 * 红线：任何维度不得设「存在即高分」的装饰性保底——总分进六轴雷达与推荐排序
 * （reviewPipelineTotal），虚高地板会同时污染展示画像与推荐位排序。
 */

export interface PipelineDimension {
  key: 'coverage' | 'practicality' | 'pedagogy' | 'modernity' | 'production' | string;
  label: string;
  /** 0-100 */
  score: number;
  /** 人读明细（雷达图与治理明细展示用） */
  detail: string;
}

export interface PipelineScore {
  /** 0-100 加权总分 */
  total: number;
  passed: boolean;
  /** sidecar 不可达时标记（Fail-Closed 拒绝发布） */
  unavailable?: boolean;
  dimensions: PipelineDimension[];
}

const WEIGHTS = {
  coverage: 0.25,
  practicality: 0.25,
  pedagogy: 0.20,
  production: 0.15,
  modernity: 0.15,
} as const;

function clampScore(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * AST 口径优先：经 Go sidecar /v1/market/repo-audit（enforce=false 只评分
 * 不落 qualityHold）取真实语法节点五维分。
 * Fail-Closed：若 sidecar 不可达，禁止降级本地正则评分，返回 unavailable 标记，
 * 由 decideReview 决策拒绝自动发布并转人工审核。
 */
export async function computePipelineScore(repositoryId: string): Promise<PipelineScore> {
  try {
    const audit = await callSidecar<{
      ok: boolean;
      score: number;
      floor: number;
      dims: { coverage: number; practicality: number; pedagogy: number; modernity: number; production: number };
    }>(
      '/v1/market/repo-audit',
      { repositoryId, enforce: false },
      { label: 'review-pipeline-score-ast', timeoutMs: 30_000 }
    );
    if (audit?.ok && audit.dims) {
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
        ).map(([key, label, score]) => ({ key, label, score, detail: 'AST 真语法节点口径（Go sidecar）' })),
      };
    }
  } catch {
    // sidecar 不可达：Fail-Closed，返回 unavailable 标记，由调用方决策拒绝
  }
  // Sidecar 不可达时不降级正则，返回 unavailable 标记（total:0 会被 decideReview 拒绝发布）
  return {
    total: 0,
    passed: false,
    unavailable: true,
    dimensions: [],
  };
}

export async function computePipelineScoreLocal(repositoryId: string): Promise<PipelineScore> {
  const repo = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: {
      outlines: {
        where: { isActive: true },
        select: { chapters: { select: { id: true } } },
      },
    },
  });
  const docs = await prisma.document.findMany({
    where: { repositoryId },
    select: {
      status: true,
      content: true,
      title: true,
      contentId: true,
      contentRef: { select: { content: true } },
    },
  });

  const total = docs.length;
  const processed = docs.filter((d) => d.status === 'PROCESSED').length;
  const errored = docs.filter((d) => d.status === 'ERROR').length;
  const outline = repo?.outlines?.[0];
  const chapterCount = outline?.chapters?.length ?? 0;

  // ── 维度 1：模块覆盖度 (Coverage) ──
  const coverageScore = total === 0
    ? 0
    : clampScore((processed / total) * 100 - (errored / total) * 40);
  const coverage: PipelineDimension = {
    key: 'coverage',
    label: '模块覆盖',
    score: coverageScore,
    detail: `${processed}/${total} 篇核心章节已生成${errored > 0 ? `，${errored} 篇需重试` : ''}`,
  };

  // ── 维度 2：代码实操度 (Practicality) ──
  let totalLines = 0;
  let codeLines = 0;
  let codeBlockCount = 0;
  let errorHandlingCount = 0;
  let modernPatternCount = 0;

  for (const doc of docs) {
    const text = doc.contentRef?.content ?? doc.content ?? '';
    if (!text.trim()) continue;
    const lines = text.split('\n');
    totalLines += lines.length;
    let inCode = false;
    for (const line of lines) {
      if (line.trim().startsWith('```')) {
        inCode = !inCode;
        if (inCode) codeBlockCount++;
      } else if (inCode) {
        codeLines++;
      }
    }
    // 粗粒度探测生产与现代代码特征
    if (/try\s*\{|catch\s*\(|onError|fallback|retry|timeout|abortController/i.test(text)) errorHandlingCount++;
    if (/import\s+|export\s+|async\s+function|const\s+\w+\s*=\s*async|await\s+/i.test(text)) modernPatternCount++;
  }

  const codeRatio = totalLines > 0 ? codeLines / totalLines : 0;
  const practicalityScore = clampScore(
    codeRatio >= 0.20
      ? 90 + Math.min(10, codeBlockCount * 0.5)
      : codeRatio >= 0.10
      ? 75 + codeRatio * 100
      : codeRatio > 0
      ? 50 + codeRatio * 250
      : Math.min(45, codeBlockCount * 5)
  );
  const practicality: PipelineDimension = {
    key: 'practicality',
    label: '代码实操',
    score: practicalityScore,
    detail: `${codeBlockCount} 处实操代码块与配置示例（代码密度 ${Math.round(codeRatio * 100)}%）`,
  };

  // ── 维度 3：认知梯度与编排 (Pedagogy) ──
  const pedagogyScore = chapterCount > 0
    ? clampScore(
        chapterCount >= 8
          ? 95
          : chapterCount >= 4
          ? 80 + (chapterCount - 4) * 3.75
          : 65 + chapterCount * 3.75
      )
    : clampScore(Math.min(60, total * 8));
  const pedagogy: PipelineDimension = {
    key: 'pedagogy',
    label: '认知梯度',
    score: pedagogyScore,
    detail: chapterCount > 0
      ? `${chapterCount} 个教学章节，循序渐进由浅入深编排`
      : `未激活独立大纲树，按 ${total} 篇文档顺序编排`,
  };

  // ── 维度 4：前沿时效 (Modernity) ──
  // 按含现代语法范式的文档占比线性计分（0 篇含 = 0 分），不做存在性保底
  const modernityRatio = total > 0 ? modernPatternCount / total : 0;
  const modernityScore = clampScore(modernityRatio * 100);
  const modernity: PipelineDimension = {
    key: 'modernity',
    label: '前沿时效',
    score: modernityScore,
    detail: `${modernPatternCount}/${total} 篇含现代语法范式（import / async / await 等）`,
  };

  // ── 维度 5：生产实战 (Production) ──
  // 按含异常处理与工程考量的文档占比线性计分（0 篇含 = 0 分），不做存在性保底
  const productionRatio = total > 0 ? errorHandlingCount / total : 0;
  const productionScore = clampScore(productionRatio * 100);
  const production: PipelineDimension = {
    key: 'production',
    label: '生产实战',
    score: productionScore,
    detail: `${errorHandlingCount}/${total} 篇含异常处理与工程落地考量（try/catch / retry / timeout 等）`,
  };

  const finalTotal = clampScore(
    coverage.score * WEIGHTS.coverage +
      practicality.score * WEIGHTS.practicality +
      pedagogy.score * WEIGHTS.pedagogy +
      modernity.score * WEIGHTS.modernity +
      production.score * WEIGHTS.production
  );

  return {
    total: finalTotal,
    passed: finalTotal >= REVIEW_THRESHOLDS.pipelinePass,
    dimensions: [coverage, practicality, pedagogy, modernity, production],
  };
}
