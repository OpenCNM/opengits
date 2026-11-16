import { z } from 'zod';
import { prisma } from '@/lib/db';
import { REVIEW_THRESHOLDS } from './config';
import { PromptRegistry } from '@/lib/prompt-registry';
import type { HistoricalReviewContext } from './history';

/**
 * LLM 初审（语义质量通道）：结构化输出分数 + 维度 + 顾虑 + 置信度。
 * 失败策略：无 key / 超时 / 解析失败 → confidence 0 → 强制进 admin 队列，绝不阻塞提交。
 */


export const reviewSchema = z.object({
  overallScore: z.number().min(0).max(100).describe('Overall architecture & tutorial quality score on a 0-100 scale (e.g. 85, 90). MUST be 0-100, NEVER 0-10.'),
  archetype: z.enum([
    'CODE_DIVER',
    'SYSTEM_ARCHITECT',
    'HOLISTIC_PRIMER',
    'FOCUSED_CORE',
    'BALANCED',
    'ARCHITECTURE',
    'PRACTICAL',
    'COMPREHENSIVE',
    'PRODUCTION',
    'MODERN',
    'TUTORIAL',
  ]).describe('Primary pedagogical profile: CODE_DIVER (硬核源码), SYSTEM_ARCHITECT (宏观架构), HOLISTIC_PRIMER (通俗入门), FOCUSED_CORE (直击核心), BALANCED (全能综合)'),
  coreHighlight: z.string().describe('Extremely concise core strength/highlight phrase in Chinese (max 18 characters, e.g. "深入剖析 Harness 与审核模式")'),
  targetAudience: z.string().describe('Extremely concise target audience description in Chinese (max 16 characters, e.g. "AI 架构师与系统开发者")'),
  dimensions: z.array(z.object({
    name: z.string().describe('Dimension key: depth (架构深度) / pedagogy (深入浅出) / codeFidelity (源码剖析) / coverage (体系全景)'),
    score: z.number().min(0).max(100).describe('Dimension score 0-100 (e.g. 85, 90). MUST be 0-100, NEVER 0-10.'),
    comment: z.string().describe('One-sentence concise Chinese comment explaining this dimension score (max 20 characters)'),
  })).min(4).max(6),
  concerns: z.array(z.string().describe('Concrete concern in Chinese, empty if none')).max(8),
  confidence: z.number().min(0).max(1).describe('Self-assessed confidence in this review'),
  safetyFlag: z.boolean().describe('TRUE only for clearly harmful, illegal, or infringing content. Normal tutorials must be false.'),
});

export interface LlmReviewResult {
  overallScore: number;
  archetype?:
    | 'CODE_DIVER'
    | 'SYSTEM_ARCHITECT'
    | 'HOLISTIC_PRIMER'
    | 'FOCUSED_CORE'
    | 'BALANCED'
    | 'ARCHITECTURE'
    | 'PRACTICAL'
    | 'COMPREHENSIVE'
    | 'PRODUCTION'
    | 'MODERN'
    | 'TUTORIAL';
  coreHighlight?: string;
  targetAudience?: string;
  summary?: string;
  passed: boolean;
  confidence: number;
  /** 安全阻断门：仅明显有害/违法/侵权为 true（质量差不算，由分数与排序消化） */
  safetyFlag: boolean;
  dimensions: Array<{ name: string; score: number; comment: string }>;
  concerns: string[];
  /** 审核通道不可用降级标记（fail-closed：转人工队列，不自动公开） */
  unavailable?: boolean;
  /** 通道不可用的归因（config_missing / call_failed / budget_exceeded），供发布反馈分层提示 */
  failureReason?: string;
  /** 命中平台关键词黑名单（未调用 LLM 即扣留） */
  keywordHit?: boolean;
}

interface ChapterPedagogicalDigest {
  title: string;
  charCount: number;
  codeBlockCount: number;
  mermaidDiagrams: string[];
  intro: string;
  analogies: string[];
  codeSnippets: string[];
  summary: string;
}

function extractChapterPedagogicalDigest(content: string, title: string): ChapterPedagogicalDigest {
  const charCount = content.length;

  // 1. 提取关键架构图 (Mermaid) —— 架构可视化与系统蓝图的核心证据
  const mermaidDiagrams: string[] = [];
  const mermaidRegex = /```mermaid\s*([\s\S]*?)```/g;
  let mMatch: RegExpExecArray | null;
  while ((mMatch = mermaidRegex.exec(content)) !== null) {
    mermaidDiagrams.push(mMatch[1].trim());
    if (mermaidDiagrams.length >= 2) break;
  }

  // 2. 统计并提取代码切片 —— 评估代码信噪比与契约提炼质量
  const rawCodeBlocks: string[] = [];
  const codeBlockRegex = /```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g;
  let cbMatch: RegExpExecArray | null;
  while ((cbMatch = codeBlockRegex.exec(content)) !== null) {
    if (!cbMatch[0].startsWith('```mermaid')) {
      rawCodeBlocks.push(cbMatch[0]);
    }
  }
  const codeBlockCount = rawCodeBlocks.length;

  // 提取前 2 个关键代码块进行切片采样（超长截取前 25 行并标注，防 Token 滥耗）
  const codeSnippets = rawCodeBlocks.slice(0, 2).map((block) => {
    const bLines = block.split('\n');
    if (bLines.length <= 25) return block;
    return bLines.slice(0, 20).join('\n') + `\n// ... (该代码切片原含 ${bLines.length} 行，其余样板细节已精简) ...\n\`\`\``;
  });

  // 3. 提取纯文本自然语言段落
  const textWithoutCode = content.replace(/```[\s\S]*?```/g, '\n');
  const rawParagraphs = textWithoutCode
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[#*`>]/g, '').trim())
    .filter(Boolean);
  const paragraphs = rawParagraphs.filter((p) => p.length > 25);

  const intro = (paragraphs[0] || rawParagraphs[0] || '').slice(0, 260);

  // 4. 提取通俗类比、设计动机与核心权衡（深入浅出的核心物理证据）
  const analogyKeywords = ['比作', '犹如', '如同', '就像', '类似于', '比如', '好比', '设计动机', '核心权衡', '为什么', '设计意图', 'trade-off'];
  const analogies: string[] = [];
  for (const p of paragraphs) {
    if (analogyKeywords.some((kw) => p.toLowerCase().includes(kw.toLowerCase()))) {
      analogies.push(p.slice(0, 220));
      if (analogies.length >= 2) break;
    }
  }

  const summary = paragraphs.length > 2 ? paragraphs[paragraphs.length - 1].slice(0, 180) : '';

  return {
    title,
    charCount,
    codeBlockCount,
    mermaidDiagrams,
    intro,
    analogies,
    codeSnippets,
    summary,
  };
}

/** 初审上下文：仓库定位 + 章节大纲 + 内容节选（质量评分与安全判据的共同输入） */
export interface ReviewContext {
  owner: string;
  repo: string;
  bestUsedFor: string;
  chapterTitles: string[];
  excerpts: string;
  historicalContext?: HistoricalReviewContext;
}

/**
 * 结构化供给全景教学切片与客观事实看板（彻底消除盲人摸象）。
 * 覆盖全部章节（不再截断前 6 章），供给 DAG 拓扑、类比动机、Mermaid 架构图与核心代码切片。
 */
export async function gatherReviewContext(
  repositoryId: string,
  historicalContext?: HistoricalReviewContext
): Promise<ReviewContext | null> {
  const repo = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: {
      owner: true,
      repo: true,
      bestUsedFor: true,
      outlines: {
        where: { isActive: true },
        select: { chapters: { orderBy: { teachingOrder: 'asc' }, select: { title: true } } },
      },
    },
  });
  if (!repo) {
    return null;
  }

  // 读取该教程的全部文档行（按标题与路径升序）
  const docs = await prisma.document.findMany({
    where: {
      repositoryId,
      status: 'PROCESSED',
      OR: [{ content: { not: null } }, { contentId: { not: null } }],
    },
    select: {
      title: true,
      path: true,
      content: true,
      contentRef: { select: { content: true } },
    },
    orderBy: { path: 'asc' },
  });

  const outlineTitles = (repo.outlines?.[0]?.chapters ?? []).map((c) => c.title).filter(Boolean);
  const chapterTitles = outlineTitles.length > 0 ? outlineTitles : docs.map((d) => d.title || d.path);

  // 对每个章节抽取高密度教研特征切片
  const digests = docs.map((d) => {
    const rawContent = d.contentRef?.content ?? d.content ?? '';
    return extractChapterPedagogicalDigest(rawContent, d.title || d.path);
  });

  const totalChapters = docs.length;
  const totalChars = digests.reduce((sum, d) => sum + d.charCount, 0);
  const totalCodeBlocks = digests.reduce((sum, d) => sum + d.codeBlockCount, 0);
  const avgCodeBlocks = totalChapters > 0 ? (totalCodeBlocks / totalChapters).toFixed(1) : '0';

  // 构造结构化事实看板
  const excerptsHeader = [
    `=== 教程客观事实看板 ===`,
    `- 总章节数: ${totalChapters} 篇`,
    `- 正文总字符量: 约 ${Math.round(totalChars / 1000)}k 字符`,
    `- 代码块总数: ${totalCodeBlocks} 处 (平均每篇 ${avgCodeBlocks} 处)`,
    `- 章节目录拓扑:`,
    chapterTitles.map((t, idx) => `  ${idx + 1}. ${t}`).join('\n') || '  (无明确大纲)',
    `========================\n`,
  ].join('\n');

  // 控制单次初审上下文总容量（兼顾 Token 预算与全景完整度，最多保留 16 篇代表性精粹）
  const selectedDigests = digests.length <= 16
    ? digests
    : [...digests.slice(0, 10), ...digests.slice(-6)];

  const excerptsBody = selectedDigests.map((d, idx) => {
    const parts: string[] = [];
    parts.push(`### 章节 ${idx + 1}: ${d.title} (约 ${Math.round(d.charCount / 1000 * 10) / 10}k字, ${d.codeBlockCount}处代码块)`);
    if (d.intro) {
      parts.push(`> **导言**: ${d.intro}`);
    }
    if (d.analogies.length > 0) {
      parts.push(`- **通俗类比与设计动机**: ${d.analogies.join('；')}`);
    }
    if (d.mermaidDiagrams.length > 0) {
      parts.push(`- **架构图解 (Mermaid)**:\n\`\`\`mermaid\n${d.mermaidDiagrams[0]}\n\`\`\``);
    }
    if (d.codeSnippets.length > 0) {
      parts.push(`- **代表性核心代码切片**:\n${d.codeSnippets[0]}`);
    }
    if (d.summary) {
      parts.push(`- **小结**: ${d.summary}`);
    }
    return parts.join('\n');
  }).join('\n\n---\n\n');

  return {
    owner: repo.owner,
    repo: repo.repo,
    bestUsedFor: (repo.bestUsedFor ?? []).join('; ') || 'General Developer Tutorial',
    chapterTitles,
    excerpts: `${excerptsHeader}\n${excerptsBody}`,
    historicalContext,
  };
}

export const prepareReviewContext = gatherReviewContext;

/** 初审提示词（六维质量画像 + 安全裁决；支持注入历史审评上下文进行连贯性校准） */
export async function buildReviewPrompt(ctx: ReviewContext): Promise<string> {
  const compiled = await PromptRegistry.getCompiledPrompt('tutorial_pedagogical_review', {
    owner: ctx.owner,
    repo: ctx.repo,
    bestUsedFor: ctx.bestUsedFor,
    chapterOutline: ctx.chapterTitles.map((t, i) => `${i + 1}. ${t}`).join('\n') || '(no outline)',
    excerpts: ctx.excerpts || '(empty)',
  });
  let promptText = compiled.compiledPrompt;

  if (ctx.historicalContext) {
    const hc = ctx.historicalContext;
    const historyLines: string[] = [
      '\n\n=== 历史审评基线与本次校准上下文 (Review History & Calibration Context) ===',
      `- 上次评定综合得分: ${typeof hc.previousScore === 'number' ? `${hc.previousScore} 分` : '暂无'}`,
      `- 上次判定流派风格: ${hc.previousArchetype || '未指定'}`,
      `- 上次核心教研亮点: ${hc.previousHighlight || '未指定'}`,
    ];
    if (hc.previousDimensions && hc.previousDimensions.length > 0) {
      historyLines.push(
        `- 上次各维度得分: ${hc.previousDimensions.map((d) => `${d.name}=${d.score}分(${d.comment || ''})`).join('; ')}`
      );
    }
    const triggerLabel =
      hc.trigger === 'owner_manual'
        ? '所有者发起重评'
        : hc.trigger === 'platform_patrol'
          ? '平台凌晨定期巡检复核'
          : '首次发布初审';
    historyLines.push(
      `- 本次审评触发方式: ${triggerLabel}`,
      `- 本次审评核心关注与原因: ${hc.reason || '教程特性画像质量校准'}`,
      '【历史延续性与校准评定指引】',
      '请在严格基于教程当前客观事实的前提下，严谨参考上述历史评分与复核诉求进行校准：',
      '1. 若历史评分或流派判定确实存在明显偏离（如低估了宏观架构抽象、或虚高堆砌了无解释代码），请据实修正，并在亮点/小结中体现调整理由；',
      '2. 若历史评分基本准确，请保持评分尺度的稳健性与连续性，避免在缺少物理证据的情况下发生无序、突兀的跳跃跑偏；',
      '3. 评分依据必须严格立足于事实看板中的模块划分、类比深度与代码切片质量。',
      '========================================================================\n'
    );
    promptText += historyLines.join('\n');
  }

  return promptText;
}

/** 结构化输出 → 审核结果（0-10 分制自动归一化为 0-100，防 LLM 误用十分制） */
export function toLlmReviewResult(object: z.infer<typeof reviewSchema>): LlmReviewResult {
  const normScore = (s: number) => (s <= 10 && s > 0 ? Math.round(s * 10) : Math.min(100, Math.max(0, Math.round(s))));
  const rawScore = normScore(object.overallScore);
  const dimensions = object.dimensions.map((d) => ({
    ...d,
    score: normScore(d.score),
  }));

  // 流派自适应加权机制 (Archetype-Aware Adaptive Scoring)：
  // 杜绝通用程序员尺子一刀切误伤：根据教程所归属的教学流派，采用匹配的加权模型重算综合分
  const dimMap = new Map(dimensions.map((d) => [d.name, d.score]));
  const depth = dimMap.get('depth') ?? rawScore;
  const pedagogy = dimMap.get('pedagogy') ?? rawScore;
  const codeFidelity = dimMap.get('codeFidelity') ?? rawScore;
  const coverage = dimMap.get('coverage') ?? rawScore;

  let adaptiveScore = rawScore;
  if (object.archetype === 'SYSTEM_ARCHITECT' || object.archetype === 'ARCHITECTURE') {
    // 宏观架构流派：核心价值是「架构深度 (40%) + 深入浅出 (40%)」，全景与微观细节各占 10%
    adaptiveScore = Math.round(depth * 0.40 + pedagogy * 0.40 + coverage * 0.10 + codeFidelity * 0.10);
  } else if (object.archetype === 'CODE_DIVER' || object.archetype === 'PRACTICAL') {
    // 深度源码流派：核心价值是「源码剖析 (40%) + 架构深度 (30%) + 体系全景 (20%) + 深入浅出 (10%)」
    adaptiveScore = Math.round(codeFidelity * 0.40 + depth * 0.30 + coverage * 0.20 + pedagogy * 0.10);
  } else if (object.archetype === 'HOLISTIC_PRIMER' || object.archetype === 'TUTORIAL') {
    // 通俗入门流派：核心价值是「深入浅出 (45%) + 体系全景 (30%) + 架构深度 (15%) + 源码剖析 (10%)」
    adaptiveScore = Math.round(pedagogy * 0.45 + coverage * 0.30 + depth * 0.15 + codeFidelity * 0.10);
  } else if (object.archetype === 'FOCUSED_CORE') {
    // 直击核心流派：核心价值是「源码剖析 (35%) + 深入浅出 (35%) + 架构深度 (20%) + 体系全景 (10%)」
    adaptiveScore = Math.round(codeFidelity * 0.35 + pedagogy * 0.35 + depth * 0.20 + coverage * 0.10);
  }

  // 最终得分以流派自适应加权分为核心 (70%)，保留原始语义判定做平滑 (30%)
  const overallScore = Math.max(0, Math.min(100, Math.round(adaptiveScore * 0.75 + rawScore * 0.25)));

  return {
    overallScore,
    archetype: object.archetype,
    coreHighlight: object.coreHighlight,
    targetAudience: object.targetAudience,
    summary: object.coreHighlight,
    passed: overallScore >= REVIEW_THRESHOLDS.llmPass,
    confidence: object.confidence,
    safetyFlag: object.safetyFlag === true,
    dimensions,
    concerns: object.concerns,
  };
}

// 注：BYOK 自审通道 reviewTutorialByLLM 已拆除（2026-11 死码清理）——用户
// BYOK 模型不能审自己的内容（假端点可自判「安全」绕过审核）；发布安全
// 初审走平台中立通道 reviewTutorialByPlatform（lib/review/platform-review.ts）。

export function unavailableReviewResult(reason: string, failureReason?: string): LlmReviewResult {
  return {
    overallScore: 0,
    passed: false,
    confidence: 0,
    // fail-closed：初审通道不可用 → 转人工队列，绝不自动公开（审计矩阵 BUG-M05-02）
    safetyFlag: false,
    dimensions: [],
    concerns: [reason],
    summary: reason,
    unavailable: true,
    failureReason,
  };
}
