import { z } from 'zod';

/**
 * 接力转录契约（三件套之「输出 schema」）：
 * 无论参与者用什么模型，章节产出都收敛到统一骨架——标题树、段落类型、
 * 概念锚点、覆盖自声明。编译器（update-market/contract.ts）据此确定性
 * 拼装统一 MDX，L0-R 对源硬门据此做字段级校验。
 */

export const RELAY_SECTION_TYPES = ['intro', 'prose', 'code', 'summary'] as const;

export const RelaySectionSchema = z.object({
  type: z.enum(RELAY_SECTION_TYPES),
  heading: z.string().min(1).max(120),
  /** 段落正文（markdown；code 段含围栏代码块） */
  content: z.string().min(1),
  /** 对应源文件的小节标题（覆盖核对用，可选） */
  sourceRef: z.string().max(200).optional(),
});

export const RelayConceptAnchorSchema = z.object({
  /** 源文术语 */
  term: z.string().min(1).max(80),
  /** 本书译法（应与输入信封的术语表一致） */
  translation: z.string().min(1).max(80),
});

export const RelayTranscriptionSchema = z.object({
  title: z.string().min(1).max(200),
  sections: z.array(RelaySectionSchema).min(1).max(60),
  conceptAnchors: z.array(RelayConceptAnchorSchema).max(30).default([]),
  coverage: z.object({
    /** 源文件的小节总数（heading 计数） */
    sourceSections: z.number().int().min(0),
    /** 本次译文的覆盖小节数 */
    coveredSections: z.number().int().min(0),
  }),
});

export type RelayTranscription = z.infer<typeof RelayTranscriptionSchema>;
export type RelaySection = z.infer<typeof RelaySectionSchema>;
