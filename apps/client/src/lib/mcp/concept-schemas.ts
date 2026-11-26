import { z } from 'zod';

export const tutorialConceptCategorySchema = z.enum([
  'architecture',
  'workflow',
  'principle',
  'reflection',
]);

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

// Directed edge invariant: sourceId is prerequisite/predecessor, targetId is dependent/successor.
export const CONCEPT_EDGE_TYPES = ['prerequisite', 'related', 'part_of', 'successor'] as const;
export type ConceptEdgeType = (typeof CONCEPT_EDGE_TYPES)[number];

export const CONCEPT_EDGE_SOURCES = ['cooccurrence', 'curriculum_order', 'code_dep', 'llm_extracted'] as const;
export type ConceptEdgeSource = (typeof CONCEPT_EDGE_SOURCES)[number];

export const conceptSuperTopicSchema = z.object({
  title: z.string().min(1).max(100),
  summary: z.string().max(2000).optional(),
  rationale: z.string().max(2000).optional(),
  memberKeys: z.array(z.string().min(1)).min(1),
});
export type ConceptSuperTopic = z.infer<typeof conceptSuperTopicSchema>;

export const conceptSuperTopicsBlockSchema = z.object({
  topics: z.array(conceptSuperTopicSchema).max(100),
  generatedAt: z.string(),
  model: z.string(),
  score: z.number().optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
});

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
