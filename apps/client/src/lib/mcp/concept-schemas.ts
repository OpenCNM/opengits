import { z } from 'zod';

export const tutorialConceptCategorySchema = z.enum([
  'architecture',
  'workflow',
  'principle',
  'reflection',
]);

// ─────────────────────────────────────────────────────────────
// 全局概念 GlobalConcept（跨仓对齐层，设计规范 §3.3）
// Schema Triad：prisma/schema.prisma GlobalConcept model ↔ 此 zod ↔ GlobalConceptItem 接口
// ─────────────────────────────────────────────────────────────

export interface GlobalConceptItem {
  id: string;
  canonicalName: string;
  aliases: string[];
  description?: string | null;
  createdAt: string | Date;
}

export interface ConceptNodeItem {
  id: string;
  repositoryId: string;
  documentId?: string | null;
  chunkId?: string | null;
  headingPath?: string | null;
  conceptName: string;
  slug: string;
  canonicalKey?: string | null;
  canonicalName?: string | null;
  category: 'architecture' | 'workflow' | 'principle' | 'reflection' | string;
  principlesText?: string | null;
  authorReflections?: string | null;
  sopSteps: string[];
  summary?: string | null;
  subTopics: string[];
  tags: string[];
  createdAt: string | Date;
}

// ─────────────────────────────────────────────────────────────
// 概念图边 (TutorialConceptEdge) — Schema Triad 与
// prisma/schema.prisma 的 TutorialConceptEdge 模型保持一致
// ─────────────────────────────────────────────────────────────

/**
 * 边类型注册表：prerequisite / related / part_of / successor（禁止内联）
 *
 * 【方向契约（强制）——所有 deriver 写边时必须遵守，否则 learning_path / getConceptDependencies 会静默返回错误结果】
 * 有向边统一语义：sourceId = 先学/被依赖方，targetId = 后学/依赖方。
 *  - prerequisite: source 是 target 的前置知识（理解 target 需先掌握 source）
 *  - successor:    source 在教学顺序上先于 target（课程递进）
 *  - part_of:      source 是 target 的组成部分
 *  - related:      无方向依赖（共现），写入时按概念 id 字典序固定方向以幂等
 * 查询侧不变量：getConceptDependencies / computeLearningPathChain 沿「target 的入边」
 * 反查前置（即取 sourceId 作为先学概念）。新 deriver 不得反向写 prerequisite/successor。
 */
export const CONCEPT_EDGE_TYPES = ['prerequisite', 'related', 'part_of', 'successor'] as const;
export type ConceptEdgeType = (typeof CONCEPT_EDGE_TYPES)[number];

/** 边证据来源注册表：cooccurrence / curriculum_order / code_dep / llm_extracted（确定性优先） */
export const CONCEPT_EDGE_SOURCES = ['cooccurrence', 'curriculum_order', 'code_dep', 'llm_extracted'] as const;
export type ConceptEdgeSource = (typeof CONCEPT_EDGE_SOURCES)[number];

// ─────────────────────────────────────────────────────────────
// L2 超主题（repoProfile.conceptSuperTopics，graph-condense 凝聚产物）
// Schema Triad：repoProfile JSON 区块（无 Prisma 模型）↔ 此 zod ↔ ConceptSuperTopic 接口
// memberKeys 引用 TutorialConceptNode.canonicalKey（组键），凝聚是可重建的派生投影
// ─────────────────────────────────────────────────────────────
export const conceptSuperTopicSchema = z.object({
  title: z.string().min(1).max(100),
  summary: z.string().max(2000).optional(),
  rationale: z.string().max(2000).optional(),
  memberKeys: z.array(z.string().min(1)).min(1),
});
export type ConceptSuperTopic = z.infer<typeof conceptSuperTopicSchema>;

/** 写入 repoProfile 前的完整区块（带溯源元数据） */
export const conceptSuperTopicsBlockSchema = z.object({
  topics: z.array(conceptSuperTopicSchema).max(100),
  generatedAt: z.string(),
  /** 凝聚来源模型（BYOK 用户模型 id 或 'platform'） */
  model: z.string(),
  /** 综合质量得分（0 ~ 100，版本擂台赛评定） */
  score: z.number().optional(),
  /** 详细质量度量快照 */
  metrics: z.record(z.string(), z.unknown()).optional(),
});

// ─────────────────────────────────────────────────────────────
// 章节随堂测验（ChapterQuiz，转录 manifest quizzes 结构化落库）
// Schema Triad：prisma/schema.prisma ChapterQuiz ↔ 此 zod ↔ ChapterQuiz 接口
// ─────────────────────────────────────────────────────────────
export const chapterQuizSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  repositoryId: z.string().min(1),
  question: z.string().min(1).max(300),
  options: z.array(z.string().min(1).max(200)).min(2).max(5),
  correctIndex: z.number().int().min(0).max(4),
  explanation: z.string().max(2000).nullable().optional(),
  order: z.number().int().min(0),
  createdAt: z.union([z.string(), z.date()]).optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
});
export type ChapterQuiz = z.infer<typeof chapterQuizSchema>;
